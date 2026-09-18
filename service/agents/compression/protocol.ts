import { AppError, errorInfo } from "../../../shared/errors.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { compressionLog } from "./log.ts";
import { compressionModulesMarkdown, loadCompressionInventory } from "../../context/compression-inventory.ts";
import type { ChatMessage, ChatTool, CompletionResult, Provider } from "../../types.ts";
export type TurnSummary = { turnId: string; tag: string; userRequest: string; actions: string; result: string };
export type CompressionTurn = { turnId: string; [field: string]: unknown };

/** Format/schema failures go back to the model for self-repair; transport faults do not loop. */
export const COMPRESSION_FORMAT_ATTEMPTS = 3;

function formatFault(response: CompletionResult, toolName: string): string | null {
  if (response.finish === "error" && response.faultCode) return null;
  if (response.finish !== "tool_calls") return `finish=${response.finish}; 必须通过一次 ${toolName} 工具调用提交摘要`;
  if (response.toolCalls.length !== 1) return `toolCalls.length=${response.toolCalls.length}; 必须恰好一次 ${toolName}`;
  if (response.faultCode || !response.parseOk || !response.schemaOk || response.toolCallFaults?.length || response.missing.length) {
    return response.detail || response.faultCode || (!response.parseOk ? "parse_failed" : "schema_failed");
  }
  const call = response.toolCalls[0]!;
  if (typeof call.id !== "string" || !call.id.trim()) return "missing valid call ID";
  if (call.name !== toolName) return `tool mismatch: expected ${toolName}, received ${call.name}`;
  return null;
}

/** System = role + input shell + inventory-generated module list + output contract. */
export function compressionSystemPrompt(repoRoot: string): string {
  const inventory = loadCompressionInventory(repoRoot);
  const parts = ["turn-role.md", "turn-input.md", "turn-output.md"].map(name =>
    readFileSync(join(repoRoot, "service/agents/compression/prompts", name), "utf8").trim());
  const modules = compressionModulesMarkdown(inventory);
  // Replace the hand-maintained modules section with the inventory-generated one.
  const inputShell = parts[1]!.replace(/## 模块清单[\s\S]*$/, "").trimEnd();
  return [parts[0]!, `${inputShell}\n\n${modules}`, parts[2]!].join("\n\n");
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
      { role: "user", content: JSON.stringify({ turns: input.turns }) },
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
            instruction: `上一次 submitTurnSummaries 格式无效。summaries 必须是对象数组（不是字符串），每个输入 turnId 恰好一项，五个字段均为非空字符串。请修正后再次通过一次 ${tool.function.name} 提交。`,
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
