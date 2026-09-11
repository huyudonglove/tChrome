import { expect, test } from "bun:test";
import { resolve } from "node:path";
import type { CompletionResult, Provider } from "../../types.ts";
import { requestMatches } from "./protocol.ts";

const repoRoot = resolve(import.meta.dir, "../../..");
function response(overrides: Partial<CompletionResult> = {}): CompletionResult {
  return { finish: "tool_calls", content: "", toolCalls: [{ id: "call_matches", name: "submitMatches", arguments: { ids: ["sum_1"] } }],
    attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [], ...overrides };
}
function run(result: CompletionResult, observe?: (input: Parameters<Provider["complete"]>[0]) => void) {
  return requestMatches({ repoRoot, request: { module: "conversationHistory", tag: "状态限制", question: "是否可以修改状态" }, candidates: ["sum_1", "sum_2"].map(id => ({ id, tag: "状态", turnId: "tn_1", userRequest: "修改要求", actions: "核对状态", result: "已核对", level: 1, createdAt: "2026-09-11" })),
    provider: { async complete(input) { observe?.(input); return result; } } });
}

test("query assembles only its return tool and ignores conflicting content", async () => {
  const value = await run(response({ content: '{"ids":["outside"]}' }), input => {
    expect(input.tools.map(tool => tool.function.name)).toEqual(["submitMatches"]);
    expect(input.tools[0]!.function.parameters).toMatchObject({ required: ["ids"], additionalProperties: false });
    expect(input.messages[0]!.content).toContain("submitMatches");
    const data = JSON.parse(input.messages[1]!.content);
    expect(data.request).toEqual({module:"conversationHistory",tag:"状态限制",question:"是否可以修改状态"});
    expect(data.request).not.toHaveProperty("ids");
    expect(data.catalog.map((row: {id:string}) => row.id)).toEqual(["sum_1","sum_2"]);
  });
  expect(value).toEqual(["sum_1"]);
});

test("query accepts empty matches and deduplicates selected IDs", async () => {
  for (const ids of [[], ["sum_1", "sum_1", "sum_2"]]) {
    expect(await run(response({ toolCalls: [{ id: "call_1", name: "submitMatches", arguments: { ids } }] }))).toEqual([...new Set(ids)]);
  }
});

test("query rejects plaintext JSON, wrong name, multiple calls and failed provider flags", async () => {
  const valid = response().toolCalls[0]!;
  const cases: Partial<CompletionResult>[] = [
    { finish: "stop", content: '{"ids":["sum_1"]}', toolCalls: [] },
    { toolCalls: [] }, { toolCalls: [valid, valid] },
    { toolCalls: [{ ...valid, name: "finishTurn" }] }, { toolCalls: [{ ...valid, id: " " }] },
    { parseOk: false }, { schemaOk: false }, { faultCode: "invalid_arguments" },
    { missing: ["ids"] }, { finish: "error" },
    { toolCallFaults: [{ callId: "broken", name: "submitMatches", rawArguments: "{", detail: "invalid JSON" }] },
  ];
  for (const item of cases) await expect(run(response(item))).rejects.toThrow();
});

test("query enforces return schema and module membership even if provider reports valid", async () => {
  const values: unknown[] = [{}, { ids: "sum_1" }, { ids: [1] }, { ids: [""] }, { ids: ["outside"] },
    { ids: ["sum_1"], answer: "extra" }, [], null];
  for (const args of values) {
    await expect(run(response({ toolCalls: [{ id: "call_1", name: "submitMatches", arguments: args as Record<string, unknown> }] }))).rejects.toThrow();
  }
});
