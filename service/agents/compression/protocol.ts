import { AppError, errorInfo } from "../../../shared/errors.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { compressionLog } from "./log.ts";
import type { ChatTool, Provider } from "../../types.ts";
export type TurnSummary = { turnId: string; tag: string; userRequest: string; actions: string; result: string };
export type CompressionTurn = { turnId: string; [field: string]: unknown };

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
    const system = ["turn-role.md", "turn-input.md", "turn-output.md"].map(name =>
      readFileSync(join(input.repoRoot, "service/agents/compression/prompts", name), "utf8").trim()).join("\n\n");
    const tool = JSON.parse(readFileSync(join(input.repoRoot, "service/agents/compression/tools/submit-turn-summaries.json"), "utf8")) as ChatTool;
    const validate = new Ajv({ allErrors: true }).compile(tool.function.parameters);
    const request: Parameters<Provider["complete"]>[0] = { tools: [tool], messages: [
      { role: "system", content: system }, { role: "user", content: JSON.stringify({ turns: input.turns }) },
    ] };
    append("request", request);
    const response = await input.provider.complete(request);
    append("response", response);
    if (response.finish !== "tool_calls" || response.toolCalls.length !== 1 || response.faultCode || !response.parseOk || !response.schemaOk || response.toolCallFaults?.length || response.missing.length) throw new AppError(response.faultCode ?? "compression_failed", `Compression agent failed: ${response.faultCode ?? (!response.parseOk ? "parse_failed" : !response.schemaOk ? "schema_failed" : response.finish)}`);
    const call = response.toolCalls[0]!;
    if (typeof call.id !== "string" || !call.id.trim()) throw new Error("Compression submission missing valid call ID");
    if (call.name !== tool.function.name) throw new Error(`Compression submission tool mismatch: expected ${tool.function.name}, received ${call.name}`);
    if (!validate(call.arguments)) {
      append("validation-error", { errors: validate.errors });
      throw new Error(`Compression submission schema failed: ${JSON.stringify(validate.errors)}`);
    }
    const values = (call.arguments as { summaries: TurnSummary[] }).summaries;
    const byId = new Map(values.map(value => [value.turnId, value]));
    if (values.length !== expected.size || byId.size !== expected.size || values.some(value => !expected.has(value.turnId))) throw new Error(`Compression turn coverage mismatch: expected ${JSON.stringify([...expected])}, received ${JSON.stringify(values.map(value => value.turnId))}`);
    const summaries = input.turns.map(({ turnId }) => {
      const value = byId.get(turnId)!;
      return { turnId, tag: value.tag.trim(), userRequest: value.userRequest.trim(), actions: value.actions.trim(), result: value.result.trim() };
    });
    append("complete", { summaries });
    return summaries;
  } catch (error) {
    const { faultCode, detail, details } = errorInfo(error, "compression_failed");
    append("error", { faultCode, detail, stack: error instanceof Error ? error.stack : undefined });
    throw new AppError(faultCode, `${detail}; compression log: ${log.path}`, { ...details, logPath: log.path }, { cause: error });
  }
}
