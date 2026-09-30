import { AppError, errorInfo, modelSpeech } from "../../../shared/errors.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { compressionLog } from "./log.ts";
import { compressionSystemFromModules } from "./context/loader.ts";
import type { ChatMessage, ChatTool, CompletionResult, Provider } from "../../types.ts";

export type TurnSummary = { turnId: string; tag: string; userRequest: string; actions: string; result: string; reflection?: string; turnIds?: string[] };
export type CompressionTurn = { turnId: string; [field: string]: unknown };
export type SubmittedTurnFields = { tag: string; actions: string; result: string; reflection?: string };

/** Format/schema failures go back to the model for self-repair; transport faults do not loop. */
export const COMPRESSION_FORMAT_ATTEMPTS = 3;

function formatFault(response: CompletionResult, toolName: string): string | null {
  if (response.finish === "error" && response.faultCode) return null;
  if (response.finish !== "tool_calls") return `finish=${response.finish}; 必须通过 ${toolName} 工具调用提交摘要`;
  if (!response.toolCalls.length) return `toolCalls.length=0; 至少调用一次 ${toolName}`;
  if (response.faultCode || !response.parseOk || !response.schemaOk || response.toolCallFaults?.length || response.missing.length) {
    return response.detail || response.faultCode || (!response.parseOk ? "parse_failed" : "schema_failed");
  }
  for (const call of response.toolCalls) {
    if (typeof call.id !== "string" || !call.id.trim()) return "missing valid call ID";
    if (call.name !== toolName) return `tool mismatch: expected ${toolName}, received ${call.name}`;
  }
  return null;
}

export function userRequestFromTurn(turn: CompressionTurn): string {
  const input = turn.userInput;
  const raw = input && typeof input === "object" && "userInput" in input && typeof input.userInput === "string"
    ? input.userInput.trim()
    : "";
  if (!raw) return "本轮未提供用户输入";
  // Runtime fills userRequest from the turn's original input; keep a short excerpt so summaries can shrink the window.
  return raw.length <= 200 ? raw : `${raw.slice(0, 200)}…`;
}

/** Layered compression System: context/modules.json + overview.md + system/*.md */
export function compressionSystemPrompt(repoRoot: string): string {
  return compressionSystemFromModules(repoRoot);
}

/** User: XML tag only; field semantics live in System <compressionTurns>. */
export function compressionUserPrompt(_repoRoot: string, turns: unknown): string {
  return `<compressionTurns>\n${JSON.stringify({ turns })}\n</compressionTurns>`;
}

/** Extract {turns} from <compressionTurns> payload (raw JSON inside the tag). */
export function compressionTurnsFromUserMessage(content: string): CompressionTurn[] {
  const normalized = content.replaceAll("\r\n", "\n").trim();
  const match = normalized.match(/^<compressionTurns>\n([\s\S]*?)\n<\/compressionTurns>$/);
  return (JSON.parse((match?.[1] ?? normalized).trim()) as { turns: CompressionTurn[] }).turns;
}

export function compressionRepairInstruction(toolName: string, turnId: string, fault: string): string {
  if (fault.includes('"must be object"') || fault.includes("must be object")) {
    return `上一次参数不是对象。每个 ${toolName} 提交对象 {tag, actions, result}，三个必填字段均为非空字符串；reflection 可选。不要包数组，也不要填 turnId。本轮是 ${turnId}。大轮可拆成多条 ${toolName}（同属本轮）。请修正后在一次回包里调用一或多个 ${toolName}。`;
  }
  return `上一次 ${toolName} 无效。请看 fault。每个 ${toolName} 提交对象 {tag, actions, result}，三个必填字段均为非空字符串；reflection 可选。本轮是 ${turnId}，不要填 turnId。大轮可拆成多条 ${toolName}（同属本轮）。请修正后在一次回包里调用一或多个 ${toolName}。`;
}

/** One turn per request. One response may carry several summaries for that turn; all must be valid. */
export async function requestTurnSummaries(input: {
  provider: Provider;
  repoRoot: string;
  turn: CompressionTurn;
  dataDir: string;
  conversationId: string;
  module?: string;
}): Promise<TurnSummary[]> {
  const log = compressionLog(input.dataDir, input.conversationId);
  const append = (stage: string, data: unknown) => {
    try { log.append(stage, data); } catch {}
  };
  append("start", { conversationId: input.conversationId, module: input.module, turnId: input.turn.turnId });
  try {
    const turnId = input.turn.turnId.trim();
    if (!turnId) throw new Error("Invalid compression input turn");
    const system = compressionSystemPrompt(input.repoRoot);
    const tool = JSON.parse(readFileSync(join(input.repoRoot, "service/agents/compression/tools/submit-turn-summaries.json"), "utf8")) as ChatTool;
    const validate = new Ajv({ allErrors: true }).compile(tool.function.parameters);
    const baseMessages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: compressionUserPrompt(input.repoRoot, [input.turn]) },
    ];
    let lastError = "";
    for (let attempt = 1; attempt <= COMPRESSION_FORMAT_ATTEMPTS; attempt++) {
      const messages: ChatMessage[] = attempt === 1 ? baseMessages : [
        ...baseMessages,
        {
          role: "user",
          content: JSON.stringify({
            selfRepair: true,
            attempt,
            maxAttempts: COMPRESSION_FORMAT_ATTEMPTS,
            fault: modelSpeech(lastError),
            instruction: modelSpeech(compressionRepairInstruction(tool.function.name, turnId, lastError)),
          }),
        },
      ];
      const request: Parameters<Provider["complete"]>[0] = { tools: [tool], messages };
      append("request", { attempt, ...request });
      const response = await input.provider.complete(request);
      append("response", { attempt, ...response });
      if (response.finish === "error" && response.faultCode) {
        throw new AppError(response.faultCode, `Compression agent failed: ${response.faultCode}`);
      }
      const protocolFault = formatFault(response, tool.function.name);
      if (protocolFault) {
        lastError = protocolFault;
        append("format-error", { attempt, detail: protocolFault });
        if (attempt === COMPRESSION_FORMAT_ATTEMPTS) throw new Error(`Compression agent format failed after ${COMPRESSION_FORMAT_ATTEMPTS} attempts: ${protocolFault}`);
        continue;
      }
      // All calls in the response must validate; a partial batch is not committed.
      const summaries: TurnSummary[] = [];
      let schemaFault: string | null = null;
      for (const call of response.toolCalls) {
        if (!validate(call.arguments)) {
          schemaFault = `Compression submission schema failed: ${JSON.stringify(validate.errors)}`;
          break;
        }
        const value = call.arguments as SubmittedTurnFields;
        const reflection = value.reflection?.trim();
        summaries.push({
          turnId,
          tag: value.tag.trim(),
          userRequest: userRequestFromTurn(input.turn),
          actions: value.actions.trim(),
          result: value.result.trim(),
          ...(reflection ? { reflection } : {}),
        });
      }
      if (schemaFault) {
        lastError = schemaFault;
        append("validation-error", { attempt, errors: validate.errors });
        if (attempt === COMPRESSION_FORMAT_ATTEMPTS) throw new Error(lastError);
        continue;
      }
      append("complete", { attempt, summaries });
      return summaries;
    }
    throw new Error(`Compression agent format failed after ${COMPRESSION_FORMAT_ATTEMPTS} attempts: ${lastError}`);
  } catch (error) {
    const { faultCode, detail, details } = errorInfo(error, "compression_failed");
    append("error", { faultCode, detail, stack: error instanceof Error ? error.stack : undefined });
    throw new AppError(faultCode, `${detail}; compression log: ${log.path}`, { ...details, logPath: log.path }, { cause: error });
  }
}

export type FoldRow = { turnId: string; tag: string; userRequest: string; actions: string; result: string; reflection?: string };

/** Span id for a cross-turn fold record, e.g. tn_01..tn_12. */
export function foldSpanId(turnIds: string[]): string {
  return `${turnIds[0]}..${turnIds[turnIds.length - 1]}`;
}

/**
 * One model call merges several summary rows into a single stage record.
 * Same tool/schema as per-turn summaries; the runtime fills turnId/userRequest.
 */
export async function requestCrossTurnFold(input: {
  provider: Provider;
  repoRoot: string;
  level: number;
  turnIds: string[];
  rows: FoldRow[];
  dataDir: string;
  conversationId: string;
  module?: string;
}): Promise<TurnSummary> {
  const log = compressionLog(input.dataDir, input.conversationId);
  const append = (stage: string, data: unknown) => {
    try { log.append(stage, data); } catch {}
  };
  const spanId = foldSpanId(input.turnIds);
  const tier = input.level >= 3 ? "L3" : "L2";
  append("fold-start", { conversationId: input.conversationId, module: input.module, spanId, level: input.level, turns: input.turnIds.length });
  try {
    const system = compressionSystemPrompt(input.repoRoot);
    const tool = JSON.parse(readFileSync(join(input.repoRoot, "service/agents/compression/tools/submit-turn-summaries.json"), "utf8")) as ChatTool;
    const validate = new Ajv({ allErrors: true }).compile(tool.function.parameters);
    const baseMessages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: `<summaryFold>\n${JSON.stringify({ level: input.level, turnIds: input.turnIds, summaries: input.rows })}\n</summaryFold>\n把以上 ${input.rows.length} 条轮次摘要合并成一条${tier}阶段纪要：覆盖哪些轮次、共同推进了什么、阶段结论是什么。只通过 ${tool.function.name} 提交 {tag, actions, result}（reflection 可选），不要填 turnId。` },
    ];
    let lastError = "";
    for (let attempt = 1; attempt <= COMPRESSION_FORMAT_ATTEMPTS; attempt++) {
      const messages: ChatMessage[] = attempt === 1 ? baseMessages : [
        ...baseMessages,
        { role: "user", content: JSON.stringify({ selfRepair: true, attempt, maxAttempts: COMPRESSION_FORMAT_ATTEMPTS, fault: modelSpeech(lastError), instruction: modelSpeech(`上一次折叠提交无效。每个 ${tool.function.name} 提交对象 {tag, actions, result}，三个必填字段均为非空字符串；不要包数组，也不要填 turnId。本轮折叠跨度 ${spanId}。`) }) },
      ];
      const request: Parameters<Provider["complete"]>[0] = { tools: [tool], messages };
      append("fold-request", { attempt, ...request });
      const response = await input.provider.complete(request);
      append("fold-response", { attempt, ...response });
      if (response.finish === "error" && response.faultCode) {
        throw new AppError(response.faultCode, `Compression fold agent failed: ${response.faultCode}`);
      }
      const protocolFault = formatFault(response, tool.function.name);
      if (protocolFault) {
        lastError = protocolFault;
        append("fold-format-error", { attempt, detail: protocolFault });
        if (attempt === COMPRESSION_FORMAT_ATTEMPTS) throw new Error(`Compression fold format failed after ${COMPRESSION_FORMAT_ATTEMPTS} attempts: ${protocolFault}`);
        continue;
      }
      const call = response.toolCalls[0]!;
      if (!validate(call.arguments)) {
        lastError = `Compression fold schema failed: ${JSON.stringify(validate.errors)}`;
        append("fold-validation-error", { attempt, errors: validate.errors });
        if (attempt === COMPRESSION_FORMAT_ATTEMPTS) throw new Error(lastError);
        continue;
      }
      const value = call.arguments as SubmittedTurnFields;
      const reflection = value.reflection?.trim();
      const userRequest = input.rows.length === 1
        ? input.rows[0]!.userRequest
        : `覆盖 ${input.turnIds.length} 轮（${input.turnIds[0]}…${input.turnIds[input.turnIds.length - 1]}）`;
      return {
        turnId: spanId,
        turnIds: input.turnIds,
        tag: value.tag.trim(),
        userRequest,
        actions: value.actions.trim(),
        result: value.result.trim(),
        ...(reflection ? { reflection } : {}),
      };
    }
    throw new Error("Compression fold produced no summary");
  } catch (error) {
    const info = errorInfo(error, "tool_execution_failed");
    append("fold-error", { detail: info.detail || info.message });
    throw error;
  }
}
