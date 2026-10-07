import type {
  ChatMessage,
  ChatTool,
  Provider,
} from "../../types.ts";
import {
  assertValidSubagentResult,
  assertValidTaskPacket,
} from "./validator.ts";
import { buildTaskPrompt } from "./prompt.ts";
import type {
  SubagentCapability,
  SubagentContext,
  SubagentEvidence,
  SubagentExecutor,
  SubagentResult,
  TaskPacket,
} from "./types.ts";

export type SubagentToolCall = {
  name: string;
  arguments: Record<string, unknown>;
  signal?: AbortSignal;
};

export type SubagentToolExecution = {
  text: string;
  evidence?: readonly SubagentEvidence[];
};

export type SubagentExecutorOptions = {
  /** The same configured Provider used by the host, with an independent message list. */
  provider: Provider;
  /** Candidate tools. The executor applies the packet permission policy before exposing them. */
  tools?: readonly ChatTool[];
  /** Explicit capability labels are required for a tool to be exposed to a role. */
  toolCapabilities?: Readonly<Record<string, readonly SubagentCapability[]>>;
  /** Runtime-owned adapter. It is deliberately narrower than the full host tool contract. */
  executeTool?: (call: SubagentToolCall) => Promise<SubagentToolExecution>;
  maxSteps?: number;
  systemPrompt?: string;
};

/** evidence 字段契约：系统提示词与格式自修复重问共用同一份措辞。 */
const evidenceContract =
  "evidence 必须是数组，每项为对象且含 kind（observation、test、diff、artifact）与非空 summary；summary 必须是非空字符串";

/** 结果格式自修复的尝试次数（含首次）；它不占用 maxSteps 的工具步预算。 */
const RESULT_FORMAT_ATTEMPTS = 2;

const DEFAULT_SYSTEM_PROMPT = [
  "你是受限的 Subagent，只完成 <subagentTask> 中的目标。",
  "你不能扩大权限、改变任务边界或替主 Agent 宣布未验证的结论。",
  "需要工具时只调用提供给你的工具；完成后必须只返回 JSON 结果。",
  "JSON 格式：{taskId,status,summary,evidence,errors}，status 为 success、failed 或 blocked。",
  `${evidenceContract}。`,
].join("\n");

const failed = (taskId: string, summary: string, error: unknown): SubagentResult => ({
  taskId,
  status: "failed",
  summary,
  evidence: [],
  errors: [error instanceof Error ? error.message : String(error)],
});

const asJson = (content: string): unknown => {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
};

const resultFromModel = (taskId: string, content: string): SubagentResult => {
  const parsed = asJson(content) as Partial<SubagentResult>;
  const result = {
    ...parsed,
    taskId,
  } as SubagentResult;
  assertValidSubagentResult(result, taskId);
  return result;
};

const toolNamesFor = (
  packet: TaskPacket,
  tools: readonly ChatTool[],
  toolCapabilities: Readonly<Record<string, readonly SubagentCapability[]>>,
): Set<string> => {
  const permissions = new Set(packet.permissions);
  return new Set(
    tools
      .filter((tool) => {
        const capabilities = toolCapabilities[tool.function.name] ?? [];
        return capabilities.length > 0 && capabilities.every((capability) => permissions.has(capability));
      })
      .map((tool) => tool.function.name),
  );
};

const toolResultsMessage = (
  calls: readonly { name: string; result: SubagentToolExecution }[],
): ChatMessage => ({
  role: "user",
  content: `<subagentToolResults>\n${JSON.stringify(calls)}\n</subagentToolResults>`,
});

/**
 * Execute one Task Packet against a real Provider. Runtime integration is injected so the
 * executor cannot reach arbitrary tools or browser state without an explicit adapter.
 */
export async function executeSubagent(
  context: SubagentContext,
  options: SubagentExecutorOptions,
  signal?: AbortSignal,
): Promise<SubagentResult> {
  const { packet, dependencyResults } = context;
  try {
    assertValidTaskPacket(packet);
    if (signal?.aborted) return failed(packet.id, "Subagent 在开始前已取消", new Error("aborted"));

    const allTools = options.tools ?? [];
    const capabilityMap = options.toolCapabilities ?? {};
    const allowedNames = toolNamesFor(packet, allTools, capabilityMap);
    const tools = allTools.filter((tool) => allowedNames.has(tool.function.name));
    const messages: ChatMessage[] = [
      { role: "system", content: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
      { role: "user", content: buildTaskPrompt(packet, dependencyResults) },
    ];
    const maxSteps = Math.max(1, Math.floor(options.maxSteps ?? 8));
    const evidence: SubagentEvidence[] = [];

    for (let step = 0; step < maxSteps; step += 1) {
      if (signal?.aborted) return failed(packet.id, "Subagent 执行被取消", new Error("aborted"));
      const completion = await options.provider.complete({ messages, tools, signal, toolChoice: "auto" });
      if (completion.finish === "error") {
        return failed(packet.id, "Provider 未能完成 Subagent 任务", new Error(completion.detail ?? completion.faultCode ?? "provider_error"));
      }
      if (completion.finish === "stop") {
        // 结构化结果是最容易出错的一环：模型少写一个字段不该让整次委派白跑。
        // 校验不通过时先按协议纠正重问（不计入 maxSteps 的工具步预算），仍不合格才判 failed。
        let content = completion.content;
        for (let attempt = 1; attempt <= RESULT_FORMAT_ATTEMPTS; attempt += 1) {
          try {
            const result = resultFromModel(packet.id, content);
            return evidence.length ? { ...result, evidence: [...result.evidence, ...evidence] } : result;
          } catch (error) {
            if (attempt === RESULT_FORMAT_ATTEMPTS) {
              return failed(packet.id, "Subagent 输出或执行协议无效", error);
            }
            if (signal?.aborted) return failed(packet.id, "Subagent 执行被取消", new Error("aborted"));
            messages.push({ role: "user", content: `<subagentModelStep>${content}</subagentModelStep>` });
            messages.push({
              role: "user",
              content: JSON.stringify({
                selfRepair: true,
                attempt,
                maxAttempts: RESULT_FORMAT_ATTEMPTS,
                fault: error instanceof Error ? error.message : String(error),
                instruction: `上一次返回的 JSON 结果未通过校验。请只重新返回一个 JSON 对象 {taskId,status,summary,evidence,errors}，taskId 必须是 ${packet.id}；${evidenceContract}。不要附带解释文字。`,
              }),
            });
            const repair = await options.provider.complete({ messages, tools, signal, toolChoice: "auto" });
            if (repair.finish === "error") {
              return failed(packet.id, "Provider 未能完成 Subagent 任务", new Error(repair.detail ?? repair.faultCode ?? "provider_error"));
            }
            if (repair.finish !== "stop") {
              return failed(packet.id, "格式纠正重问没有返回 JSON 结果", new Error("format_repair_unexpected_finish"));
            }
            content = repair.content;
          }
        }
        return failed(packet.id, "Subagent 输出或执行协议无效", new Error("result_format_exhausted"));
      }
      if (!completion.toolCalls.length) {
        return failed(packet.id, "Provider 声明有工具调用但未返回调用内容", new Error("empty_tool_calls"));
      }
      if (!options.executeTool) {
        return failed(packet.id, "Subagent 请求工具，但当前执行器没有工具适配器", new Error("tool_executor_missing"));
      }

      const calls: { name: string; result: SubagentToolExecution }[] = [];
      for (const call of completion.toolCalls) {
        if (!allowedNames.has(call.name)) {
          return failed(packet.id, `工具 ${call.name} 不在该角色的允许白名单中`, new Error("tool_not_allowed"));
        }
        const result = await options.executeTool({ name: call.name, arguments: call.arguments, signal });
        calls.push({ name: call.name, result });
        if (result.evidence) evidence.push(...result.evidence);
      }
      messages.push({ role: "user", content: `<subagentModelStep>${completion.content}</subagentModelStep>` });
      messages.push(toolResultsMessage(calls));
    }
    return failed(packet.id, `Subagent 超过最大模型步数 ${maxSteps}`, new Error("max_steps_exceeded"));
  } catch (error) {
    return failed(packet.id, "Subagent 输出或执行协议无效", error);
  }
}

export function createSubagentExecutor(
  options: SubagentExecutorOptions,
  signal?: AbortSignal,
): SubagentExecutor {
  return (context) => executeSubagent(context, options, signal);
}
