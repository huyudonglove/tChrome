import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatTool, ExecutionMode } from "../types.ts";
import { loadCapabilityCatalog } from "./capability.ts";
import type { CapabilityRecord } from "./capability-types.ts";

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
  /** Unified metadata for tools and skills, without changing tool execution contracts. */
  capabilities: CapabilityRecord[];
};

/** Optional causal backfill shared by every tool schema; models may omit them. */
const CAUSAL_BACKFILL = {
  expected: {
    type: "string",
    description: "扣动扳机前固化的成功判据：预期的环境/数据变化（看到什么才算成功）。可选。",
  },
  fallback: {
    type: "string",
    description: "未达 expected 时的熔断策略：立刻退向何处、绝不做什么。可选。",
  },
  risk: {
    type: "string",
    enum: ["low", "medium", "high"],
    description: "本次调用的风险等级。工具风险未固定或本次比平时高危时填写；high 需要活动 Task（task.set）。可选。",
  },
} as const;

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

export function loadToolRegistry(root: string): ToolRegistry {
  const index = JSON.parse(readFileSync(join(root, "service", "tools", "definitions", "index.json"), "utf8")) as ToolIndex;
  const toolGroups = JSON.parse(readFileSync(join(root, "service", "tools", "definitions", "groups.json"), "utf8")) as ToolGroups;
  const tools: Record<string, ChatTool> = {};
  const execution: Record<string, ExecutionMode> = {};
  for (const file of readdirSync(join(root, "service", "tools", "definitions"))) {
    if (!file.endsWith(".json") || ["index.json", "groups.json"].includes(file)) continue;
    const raw = JSON.parse(readFileSync(join(root, "service", "tools", "definitions", file), "utf8")) as ChatTool;
    const name = raw.function?.name;
    if (!name) continue;
    const mode: ExecutionMode = raw.execution === "parallel" ? "parallel" : "serial";
    tools[name] = injectCausalBackfill({ type: "function", function: raw.function });
    execution[name] = mode;
  }
  const capabilities = loadCapabilityCatalog(root, { tools, index, toolGroups, execution });
  return { tools, index, toolGroups, execution, capabilities };
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

/** Purpose navigation shares its source with the API description, without copying parameter/return details. */
export function toolGuideFor(registry: ToolRegistry, ids: string[]): string {
  return toolSchemas(registry, ids).map(tool => {
    const description = tool.function.description?.trim();
    if (!description) throw new Error(`missing tool description ${tool.function.name}`);
    const purpose = description.split(/[。\n]/, 1)[0]!.trim();
    const cap = registry.capabilities.find((row) => row.kind === "tool" && row.id === tool.function.name);
    const chain = [
      cap?.similar?.length ? `类似 ${cap.similar.join("/")}` : "",
      cap?.deeper?.length ? `深入 ${cap.deeper.join("/")}` : "",
    ].filter(Boolean).join("｜");
    return `- ${tool.function.name}：${purpose}。${chain || ""}`;
  }).join("\n");
}
