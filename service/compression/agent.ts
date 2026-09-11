import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "../types.ts";

export async function runJsonAgent(input: { provider: Provider; repoRoot: string; promptNames: string[]; payload: unknown }): Promise<unknown> {
  const system = input.promptNames.map(name => {
    if (!/^[a-z0-9-]+\.md$/.test(name)) throw new Error("Invalid agent prompt name");
    return readFileSync(join(input.repoRoot, "service/compression/prompts", name), "utf8").trim();
  }).join("\n\n");
  const response = await input.provider.complete({ tools: [], messages: [
    { role: "system", content: system }, { role: "user", content: JSON.stringify(input.payload) },
  ] });
  if (response.finish !== "stop" || response.toolCalls.length || response.faultCode || !response.parseOk || !response.schemaOk) throw new Error(`Context agent failed: ${response.faultCode ?? (!response.parseOk ? "parse_failed" : !response.schemaOk ? "schema_failed" : response.finish)}`);
  const text = response.content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1");
  return JSON.parse(text);
}
