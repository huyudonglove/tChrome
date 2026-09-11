import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatTool, Provider } from "../../types.ts";

export type QueryCandidate = { turnId: string; records: Record<string, unknown>[] };

// The request is semantic. Candidate identities come exclusively from the runtime archive.
export async function requestMatches(input: {
  provider: Provider; repoRoot: string;
  request: { sumId: string; module: string; intent: string };
  candidates: QueryCandidate[];
}): Promise<string[]> {
  const system = ["query-role.md", "query-match.md"].map(name => {
    return readFileSync(join(input.repoRoot, "service/agents/query/prompts", name), "utf8").trim();
  }).join("\n\n");
  const tool: ChatTool = JSON.parse(readFileSync(join(input.repoRoot, "service/agents/query/tools/submit-matches.json"), "utf8"));
  const response = await input.provider.complete({ tools: [tool], messages: [
    { role: "system", content: system }, { role: "user", content: JSON.stringify({ request: input.request, turns: input.candidates }) },
  ] });
  if (response.finish !== "tool_calls" || response.toolCalls.length !== 1 || response.faultCode
    || !response.parseOk || !response.schemaOk || response.toolCallFaults?.length || response.missing.length) {
    throw new Error(`Query agent failed: ${response.faultCode ?? "invalid_return_tool_call"}`);
  }
  const call = response.toolCalls[0]!;
  if (call.name !== "submitMatches" || typeof call.id !== "string" || !call.id.trim()) {
    throw new Error("查询 Agent 必须通过一次 submitMatches 工具调用返回结果。");
  }
  const value = call.arguments;
  const validate = new Ajv({ allErrors: true, strict: false }).compile(tool.function.parameters);
  if (!validate(value)) throw new Error("查询 Agent 返回的工具参数不符合 schema。");
  const allowed = new Set(input.candidates.map(entry => entry.turnId));
  if ((value.turnIds as string[]).some(id => !allowed.has(id))) throw new Error("查询 Agent 返回了无效或候选范围外的 turnId。");
  return [...new Set(value.turnIds as string[])];
}
