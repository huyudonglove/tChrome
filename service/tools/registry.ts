import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatTool, ExecutionMode } from "../types.ts";
import { promptNumberSlots, fillPromptNumbers } from "../context/prompt-numbers.ts";
import { loadCapabilityCatalog } from "./capability.ts";
import type { CapabilityRecord, CapabilityRisk } from "./capability-types.ts";

export type ToolIndex = {
  browser: string[];
  service: string[];
};

export type ToolGroups = {
  baseToolsIds: string[];
  coreToolIds: string[];
};

export type ToolRegistry = {
  tools: Record<string, ChatTool>;
  index: ToolIndex;
  toolGroups: ToolGroups;
  /** Per-tool default schedule when the call omits arguments.execution. */
  execution: Record<string, ExecutionMode>;
  /** Per-tool mutually exclusive argument groups, declared by the definition itself. */
  mutex: Record<string, string[][]>;
  /** Unified metadata for tools and skills, without changing tool execution contracts. */
  capabilities: CapabilityRecord[];
};

/** Optional causal backfill shared by every tool schema; models may omit them. */
const CAUSAL_BACKFILL = {
  expected: {
    type: "string",
    description: "成功判据：看到什么才算成功。可选。",
  },
  fallback: {
    type: "string",
    description: "未达 expected 时的退路。可选。",
  },
  risk: {
    type: "string",
    enum: ["low", "medium", "high"],
    description: "风险等级；high 需先 task_set。可选。",
  },
} as const;

/** Per-tool schedule note shown to the model, derived from the execution field so it can never drift. */
function executionNote(mode: ExecutionMode): string {
  return `执行调度：${mode}（Runtime 固定，不必返回）。`;
}

/** Hand-written notes are stripped from the definition before the derived one is appended. */
function withExecutionNote(fn: ChatTool["function"], mode: ExecutionMode): ChatTool["function"] {
  const description = (fn.description ?? "").replace(/执行调度：[^\n]*?。/g, "").replace(/\n+$/, "");
  return { ...fn, description: `${description}\n${executionNote(mode)}` };
}

/** Per-tool risk clause, derived from the capability catalog so the tier can never drift. */
function riskClause(risk: CapabilityRisk): string {
  return `本工具为 ${risk} 档，${risk === "low" ? "可省略" : "必填"}，`;
}

/** Hand-written risk clauses in definitions are replaced in place by the derived one; tools that had none get it appended. */
function withRiskNote(tool: ChatTool, risk: CapabilityRisk): ChatTool {
  const params = tool.function.parameters as { properties?: Record<string, { description?: unknown }> } | undefined;
  const reason = params?.properties?.reason;
  if (!params || !params.properties || !reason || typeof reason.description !== "string") return tool;
  // Any hand-written clause is stripped first and the derived one re-appended, so a definition that
  // used to carry a stale tier renders exactly the same text as one that never did.
  const stripped = reason.description
    .replace(/本工具为\s*\S+\s*档，(?:必填|可省略)[，,。]?/g, "")
    .replace(/[；;。,\s]+$/, "");
  const description = `${stripped ? `${stripped}。` : ""}${riskClause(risk).replace(/[，,]$/, "。")}`;
  return {
    ...tool,
    function: {
      ...tool.function,
      parameters: {
        ...(params as object),
        properties: { ...params.properties, reason: { ...reason, description } },
      } as ChatTool["function"]["parameters"],
    },
  };
}

function injectCausalBackfill(tool: ChatTool): ChatTool {
  const params = tool.function.parameters as { properties?: Record<string, unknown> } | undefined;
  if (!params || typeof params !== "object" || !params.properties || typeof params.properties !== "object") return tool;
  if (!("reason" in params.properties)) return tool;
  const properties: Record<string, unknown> = { ...params.properties };
  for (const [key, schema] of Object.entries(CAUSAL_BACKFILL)) {
    if (!(key in properties)) properties[key] = schema;
  }
  return {
    ...tool,
    function: {
      ...tool.function,
      parameters: { ...(params as object), properties } as ChatTool["function"]["parameters"],
    },
  };
}

/** Runtime projection choice belongs to every call, independent of business parameters. */
function injectCallRetention(tool: ChatTool, defaultKeepInCalls: boolean): ChatTool {
  const params = tool.function.parameters as { properties?: Record<string, unknown> } | undefined;
  return {
    ...tool,
    function: {
      ...tool.function,
      parameters: {
        type: "object",
        ...params,
        properties: {
          ...params?.properties,
          keepInCalls: {
            type: "boolean",
            default: defaultKeepInCalls,
            description: `是否保留本次执行证据。省略使用本工具默认值 ${defaultKeepInCalls}；可显式 true 或 false 覆盖。true 将本次调用及最终结果保留在所属 loop，直到压缩；false 仅随最近结果 loop 展示一次。Runtime 在执行时固定保留值，后续不因默认值变化重新解释历史。原始调用始终落盘，不影响工具执行。`,
          },
        },
      } as ChatTool["function"]["parameters"],
    },
  };
}

/** Low-risk calls are read-only and self-evident, so the model does not have to restate a reason for them. */
function relaxReasonRequirement(tool: ChatTool): ChatTool {
  const params = tool.function.parameters as { required?: unknown } | undefined;
  const required = params?.required;
  if (!Array.isArray(required) || !required.includes("reason")) return tool;
  return {
    ...tool,
    function: {
      ...tool.function,
      parameters: { ...(params as object), required: required.filter(key => key !== "reason") } as ChatTool["function"]["parameters"],
    },
  };
}

/** Medium and high risk calls carry intent, so reason is required even if a legacy definition omitted it. */
function enforceReasonRequirement(tool: ChatTool): ChatTool {
  const params = (tool.function.parameters ?? {}) as { required?: unknown; properties?: Record<string, unknown> };
  if (!params.properties?.reason) return tool;
  const required = Array.isArray(params.required) ? [...(params.required as string[])] : [];
  if (required.includes("reason")) return tool;
  required.push("reason");
  return {
    ...tool,
    function: {
      ...tool.function,
      parameters: { ...params, required } as ChatTool["function"]["parameters"],
    },
  };
}

/** Runtime numbers exposed to tool definitions as {{slot}} placeholders. */
const NUMBER_SLOTS = promptNumberSlots();

/** Replaces {{slot}} in definition source text with the configured number. Exported so scripts that read definition files directly stay in sync. */
export function fillNumbers(text: string): string {
  return fillPromptNumbers(text, NUMBER_SLOTS);
}

export function loadToolRegistry(root: string): ToolRegistry {
  const index = JSON.parse(readFileSync(join(root, "service", "tools", "definitions", "index.json"), "utf8")) as ToolIndex;
  const toolGroups = JSON.parse(readFileSync(join(root, "service", "tools", "definitions", "groups.json"), "utf8")) as ToolGroups;
  const tools: Record<string, ChatTool> = {};
  const execution: Record<string, ExecutionMode> = {};
  const mutex: Record<string, string[][]> = {};
  for (const file of readdirSync(join(root, "service", "tools", "definitions"))) {
    if (!file.endsWith(".json") || ["index.json", "groups.json"].includes(file)) continue;
    const source = fillNumbers(readFileSync(join(root, "service", "tools", "definitions", file), "utf8"));
    const raw = JSON.parse(source) as ChatTool;
    if (/\{\{\w+\}\}/.test(source)) throw new Error(`unresolved number placeholder in definitions/${file}`);
    const name = raw.function?.name;
    if (!name) continue;
    const mode: ExecutionMode = raw.execution === "parallel" ? "parallel" : "serial";
    tools[name] = injectCausalBackfill({ type: "function", function: withExecutionNote(raw.function, mode) });
    execution[name] = mode;
    const declaredMutex = (raw as { mutex?: unknown }).mutex;
    if (Array.isArray(declaredMutex) && declaredMutex.length > 0) mutex[name] = declaredMutex as string[][];
  }
  const capabilities = loadCapabilityCatalog(root, { tools, index, toolGroups, execution });
  for (const [name, rawTool] of Object.entries(tools)) {
    const tool = injectCallRetention(rawTool, capabilities.find(row => row.kind === "tool" && row.id === name)!.defaultKeepInCalls!);
    tools[name] = tool;
    const risk = capabilities.find((row) => row.kind === "tool" && row.id === name)?.risk;
    if (risk === "low" || risk === "medium" || risk === "high") {
      tools[name] = withRiskNote(tool, risk);
      tools[name] = risk === "low" ? relaxReasonRequirement(tools[name]) : enforceReasonRequirement(tools[name]);
    }
  }
  return { tools, index, toolGroups, execution, mutex, capabilities };
}

export function dynamicToolIds(registry: ToolRegistry): string[] {
  return [...registry.index.browser, ...registry.index.service];
}

export function coreToolIds(registry: ToolRegistry): string[] {
  return registry.toolGroups.coreToolIds.filter((id) => Boolean(registry.tools[id]));
}

export function toolSchemas(registry: ToolRegistry, ids: string[]): ChatTool[] {
  return ids.map((id) => {
    const tool = registry.tools[id];
    if (!tool) throw new Error(`unknown tool ${id}`);
    return tool;
  });
}

/** Purpose line shares its source with the API description, without copying parameter/return details. 类似/深入导航默认带上；用户 <tools> 清单不需要，只写用途。 */
export function toolGuideFor(registry: ToolRegistry, ids: string[], nav = true): string {
  return toolSchemas(registry, ids).map(tool => {
    const description = tool.function.description?.trim();
    if (!description) throw new Error(`missing tool description ${tool.function.name}`);
    const purpose = description.split(/[。\n]/, 1)[0]!.trim();
    if (!nav) return `- ${tool.function.name}：${purpose}。`;
    const cap = registry.capabilities.find((row) => row.kind === "tool" && row.id === tool.function.name);
    const chain = [
      cap?.similar?.length ? `类似 ${cap.similar.join("/")}` : "",
      cap?.deeper?.length ? `深入 ${cap.deeper.join("/")}` : "",
    ].filter(Boolean).join("｜");
    return `- ${tool.function.name}：${purpose}。${chain || ""}`;
  }).join("\n");
}

/**
 * Loaded dynamic tools this conversation never called. Retirement is the model's own call, so the
 * facts belong in the prompt: without them it picks the list from impression and gets it wrong.
 * Counts are call-based, so an amended row still counts once.
 */
export function zeroCallToolNote(registry: ToolRegistry, loadedToolIds: readonly string[], calls: readonly { name: string }[]): string {
  const dynamic = loadedToolIds.filter((id) => registry.tools[id] && !coreToolIds(registry).includes(id));
  if (dynamic.length === 0) return "";
  const called = new Set(calls.map((call) => call.name));
  const idle = dynamic.filter((id) => !called.has(id));
  if (idle.length === 0) return "";
  return `本会话加载的动态工具 ${dynamic.length} 个，零调用 ${idle.length} 个：${idle.join("、")}。`;
}
