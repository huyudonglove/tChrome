import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import type { ChatTool, Provider } from "../../types.ts";
export type TurnSummary = { turnId: string; tag: string; userRequest: string; actions: string; result: string };
export type CompressionTurn = { turnId: string; [field: string]: unknown };

export async function requestTurnSummaries(input: { provider: Provider; repoRoot: string; turns: CompressionTurn[] }): Promise<TurnSummary[]> {
  const expected = new Set(input.turns.map(turn => turn.turnId));
  if (!expected.size || expected.size !== input.turns.length) throw new Error("Invalid compression input turns");
  const system = ["turn-role.md", "turn-input.md", "turn-output.md"].map(name =>
    readFileSync(join(input.repoRoot, "service/agents/compression/prompts", name), "utf8").trim()).join("\n\n");
  const tool = JSON.parse(readFileSync(join(input.repoRoot, "service/agents/compression/tools/submit-turn-summaries.json"), "utf8")) as ChatTool;
  const validate = new Ajv({ allErrors: true }).compile(tool.function.parameters);
  const response = await input.provider.complete({ tools: [tool], messages: [
    { role: "system", content: system }, { role: "user", content: JSON.stringify({ turns: input.turns }) },
  ] });
  if (response.finish !== "tool_calls" || response.toolCalls.length !== 1 || response.faultCode || !response.parseOk || !response.schemaOk || response.toolCallFaults?.length || response.missing.length) throw new Error(`Compression agent failed: ${response.faultCode ?? (!response.parseOk ? "parse_failed" : !response.schemaOk ? "schema_failed" : response.finish)}`);
  const call = response.toolCalls[0]!;
  if (!call.id?.trim() || call.name !== tool.function.name || !validate(call.arguments)) throw new Error("Invalid compression submission tool call");
  const values = (call.arguments as { summaries: TurnSummary[] }).summaries;
  const byId = new Map(values.map(value => [value.turnId, value]));
  if (values.length !== expected.size || byId.size !== expected.size || values.some(value => !expected.has(value.turnId))) throw new Error("Compression turn coverage mismatch");
  return input.turns.map(({ turnId }) => {
    const value = byId.get(turnId)!;
    if (JSON.stringify(value).length > 12000) throw new Error("Compression output exceeds per-turn budget");
    return { turnId, tag: value.tag.trim(), userRequest: value.userRequest.trim(), actions: value.actions.trim(), result: value.result.trim() };
  });
}
