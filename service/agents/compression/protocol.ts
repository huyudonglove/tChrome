import { AppError, errorInfo, modelSpeech } from "../../../shared/errors.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { compressionLog } from "./log.ts";
import { compressionSystemFromModules } from "./context/loader.ts";
import type { ChatMessage, ChatTool, CompletionResult, Provider } from "../../types.ts";
export type TurnSummary = { turnId: string; tag: string; userRequest: string; actions: string; result: string };
export type CompressionTurn = { turnId: string; [field: string]: unknown };

/** Format/schema failures go back to the model for self-repair; transport faults do not loop. */
export const COMPRESSION_FORMAT_ATTEMPTS = 3;

function formatFault(response: CompletionResult, toolName: string): string | null {
  if (response.finish === "error" && response.faultCode) return null;
  if (response.finish !== "tool_calls") return `finish=${response.finish}; 必须通过一次 ${toolName} 工具调用提交摘要`;
  if (response.toolCalls.length !== 1) return `toolCalls.length=${response.toolCalls.length}; 这一次回包只能有一个 ${toolName}`;
  if (response.faultCode || !response.parseOk || !response.schemaOk || response.toolCallFaults?.length || response.missing.length) {
    return response.detail || response.faultCode || (!response.parseOk ? "parse_failed" : "schema_failed");
  }
  const call = response.toolCalls[0]!;
  if (typeof call.id !== "string" || !call.id.trim()) return "missing valid call ID";
  if (call.name !== toolName) return `tool mismatch: expected ${toolName}, received ${call.name}`;
  return null;
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

export async function requestTurnSummaries(input: { provider: Provider; repoRoot: string; turns: CompressionTurn[]; dataDir: string; conversationId: string; module?: string }): Promise<TurnSummary[]> {
  const log = compressionLog(input.dataDir, input.conversationId);
  const append = (stage: string, data: unknown) => {
    // Diagnostic storage must never hide a provider or validation failure.
    try { log.append(stage, data); } catch {}
  };
  append("start", { conversationId: input.conversationId, module: input.module, turnIds: input.turns.map(turn => turn.turnId) });
  try {
    const expected = new Set(input.turns.map(turn => turn.turnId));
    if (!expected.size || expected.size !== input.turns.length) throw new Error("Invalid compression input turns");
    const system = compressionSystemPrompt(input.repoRoot);
    const tool = JSON.parse(readFileSync(join(input.repoRoot, "service/agents/compression/tools/submit-turn-summaries.json"), "utf8")) as ChatTool;
    const validate = new Ajv({ allErrors: true }).compile(tool.function.parameters);
    const baseMessages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: compressionUserPrompt(input.repoRoot, input.turns) },
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
            fault: lastError,
            instruction: modelSpeech(`上一次 submitTurnSummaries 格式无效。summaries 必须是对象数组（不是字符串），本批每个 turnId 一条、不多不少，五个字段均为非空字符串。请修正后，在这一次回包里只调一次 ${tool.function.name}，把本批摘要全部放进 summaries。`),
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
      const call = response.toolCalls[0]!;
      if (!validate(call.arguments)) {
        lastError = `Compression submission schema failed: ${JSON.stringify(validate.errors)}`;
        append("validation-error", { attempt, errors: validate.errors });
        if (attempt === COMPRESSION_FORMAT_ATTEMPTS) throw new Error(lastError);
        continue;
      }
      const values = (call.arguments as { summaries: TurnSummary[] }).summaries;
      const byId = new Map(values.map(value => [value.turnId, value]));
      if (values.length !== expected.size || byId.size !== expected.size || values.some(value => !expected.has(value.turnId))) {
        lastError = `Compression turn coverage mismatch: expected ${JSON.stringify([...expected])}, received ${JSON.stringify(values.map(value => value.turnId))}`;
        append("coverage-error", { attempt, detail: lastError });
        if (attempt === COMPRESSION_FORMAT_ATTEMPTS) throw new Error(lastError);
        continue;
      }
      const summaries = input.turns.map(({ turnId }) => {
        const value = byId.get(turnId)!;
        return { turnId, tag: value.tag.trim(), userRequest: value.userRequest.trim(), actions: value.actions.trim(), result: value.result.trim() };
      });
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
