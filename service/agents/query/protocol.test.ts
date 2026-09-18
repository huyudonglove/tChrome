import { expect, test } from "bun:test";
import { resolve } from "node:path";
import type { CompletionResult, Provider } from "../../types.ts";
import { requestMatches } from "./protocol.ts";

const repoRoot = resolve(import.meta.dir, "../../..");
function response(overrides: Partial<CompletionResult> = {}): CompletionResult {
  return { finish: "tool_calls", content: "", toolCalls: [{ id: "call_matches", name: "submitMatches", arguments: { turnIds: ["tn_1"] } }],
    attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [], ...overrides };
}
function run(result: CompletionResult, observe?: (input: Parameters<Provider["complete"]>[0]) => void) {
  return requestMatches({ repoRoot, request: { sumId: "sum_01", module: "toolIO", intent: "是否可以修改状态" }, candidates: ["tn_1", "tn_2"].map(id => ({ turnId: id, records: [{ callId: "call_01", text: "状态" }] })),
    provider: { async complete(input) { observe?.(input); return result; } } });
}

test("query assembles only its return tool and ignores conflicting content", async () => {
  const value = await run(response({ content: '{"turnIds":["outside"]}' }), input => {
    expect(input.tools.map(tool => tool.function.name)).toEqual(["submitMatches"]);
    expect(input.tools[0]!.function.parameters).toMatchObject({ required: ["turnIds"], additionalProperties: false });
    expect(input.messages[0]!.content).toContain("submitMatches");
    const data = JSON.parse(input.messages[1]!.content);
    expect(data.request).toEqual({sumId:"sum_01",module:"toolIO",intent:"是否可以修改状态"});
    expect(data.request).not.toHaveProperty("turnIds");
    expect(data.turns.map((row: {turnId:string}) => row.turnId)).toEqual(["tn_1","tn_2"]);
  });
  expect(value).toEqual(["tn_1"]);
});

test("query accepts empty matches and deduplicates selected IDs", async () => {
  for (const turnIds of [[], ["tn_1", "tn_1", "tn_2"]]) {
    expect(await run(response({ toolCalls: [{ id: "call_1", name: "submitMatches", arguments: { turnIds } }] }))).toEqual([...new Set(turnIds)]);
  }
});

test("query rejects plaintext JSON, wrong name, multiple calls and failed provider flags", async () => {
  const valid = response().toolCalls[0]!;
  const cases: Partial<CompletionResult>[] = [
    { finish: "stop", content: '{"turnIds":["tn_1"]}', toolCalls: [] },
    { toolCalls: [] }, { toolCalls: [valid, valid] },
    { toolCalls: [{ ...valid, name: "finishTurn" }] }, { toolCalls: [{ ...valid, id: " " }] },
    { parseOk: false }, { schemaOk: false }, { faultCode: "invalid_arguments" },
    { missing: ["turnIds"] }, { finish: "error" },
    { toolCallFaults: [{ callId: "broken", name: "submitMatches", rawArguments: "{", detail: "invalid JSON" }] },
  ];
  for (const item of cases) await expect(run(response(item))).rejects.toThrow();
});

test("query enforces return schema and module membership even if provider reports valid", async () => {
  const values: unknown[] = [{}, { turnIds: "tn_1" }, { turnIds: [1] }, { turnIds: [""] }, { turnIds: ["outside"] },
    { turnIds: ["tn_1"], answer: "extra" }, [], null];
  for (const args of values) {
    await expect(run(response({ toolCalls: [{ id: "call_1", name: "submitMatches", arguments: args as Record<string, unknown> }] }))).rejects.toThrow();
  }
});

test("query format errors return to the model for self-repair up to three attempts", async () => {
  let calls = 0;
  const broken = response({ toolCalls: [{ id: "call_1", name: "submitMatches", arguments: { turnIds: ["outside"] } }] });
  await expect(run(broken, input => {
    calls++;
    if (calls > 1) expect(JSON.parse(input.messages.at(-1)!.content)).toMatchObject({ selfRepair: true });
  })).rejects.toMatchObject({ faultCode: "query_failed" });
  expect(calls).toBe(3);
  let fixed = 0;
  const value = await run(response({ toolCalls: [{ id: "call_1", name: "submitMatches", arguments: { turnIds: "bad" as unknown as string[] } }] }), () => {
    fixed++;
    return undefined;
  }).catch(() => null);
  // First two calls invalid type; third attempt uses a patched provider below.
  expect(value).toBeNull();
  expect(fixed).toBe(3);
});

test("query self-repair can recover on the third format attempt", async () => {
  let calls = 0;
  const result = await requestMatches({
    repoRoot,
    request: { sumId: "sum_01", module: "toolIO", intent: "查状态" },
    candidates: [{ turnId: "tn_1", records: [] }],
    provider: { async complete() {
      calls++;
      if (calls < 3) return response({ toolCalls: [{ id: "c", name: "submitMatches", arguments: { summaries: "no" } }] as never });
      return response({ toolCalls: [{ id: "c", name: "submitMatches", arguments: { turnIds: ["tn_1"] } }] });
    } },
  });
  expect(calls).toBe(3);
  expect(result).toEqual(["tn_1"]);
});

