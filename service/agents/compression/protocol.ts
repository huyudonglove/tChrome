import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import type { ChatTool, Provider } from "../../types.ts";

export async function requestSummary(input: { provider: Provider; repoRoot: string; payload: unknown }): Promise<{ tag: string; summary: string }> {
  const system = ["archive-role.md", "archive-output.md"].map(name => {
    return readFileSync(join(input.repoRoot, "service/agents/compression/prompts", name), "utf8").trim();
  }).join("\n\n");
  const tool = JSON.parse(readFileSync(join(input.repoRoot, "service/agents/compression/tools/submit-summary.json"), "utf8")) as ChatTool;
  const validate = new Ajv({ allErrors: true }).compile(tool.function.parameters);
  const response = await input.provider.complete({ tools: [tool], messages: [
    { role: "system", content: system }, { role: "user", content: JSON.stringify(input.payload) },
  ] });
  if (response.finish !== "tool_calls" || response.toolCalls.length !== 1 || response.faultCode || !response.parseOk || !response.schemaOk) throw new Error(`Compression agent failed: ${response.faultCode ?? (!response.parseOk ? "parse_failed" : !response.schemaOk ? "schema_failed" : response.finish)}`);
  const call = response.toolCalls[0]!;
  if (!call.id || call.name !== tool.function.name || !validate(call.arguments)) throw new Error("Invalid compression submission tool call");
  const value = call.arguments as { tag: string; summary: string };
  const result = { tag: value.tag.trim(), summary: value.summary.trim() };
  if (JSON.stringify(result).length > 12000) throw new Error("Compression output exceeds chunk budget");
  return result;
}
