import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { requestTurnSummaries } from "./protocol.ts";
import type { CompletionResult } from "../../types.ts";
const repoRoot = resolve(import.meta.dir, "../../..");
const summary = (turnId: string) => ({ turnId, tag: "负责人", userRequest: "改负责人", actions: "修改并核对", result: "状态未变" });
const valid: CompletionResult = { finish: "tool_calls", content: "忽略正文", toolCalls: [{ id: "result", name: "submitTurnSummaries", arguments: { summaries: [summary("tn_02"), summary("tn_01")] } }], attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [] };
const input = { repoRoot, turns: [{ turnId: "tn_01", toolIO: [] }, { turnId: "tn_02", toolIO: [] }] };
test("private submission returns exact batched turn coverage in source order", async () => {
  const result = await requestTurnSummaries({ ...input, provider: { complete: async request => {
    expect(request.tools.map(tool => tool.function.name)).toEqual(["submitTurnSummaries"]);
    expect(JSON.parse(request.messages[1]!.content)).toEqual({ turns: input.turns });
    expect(request.messages[0]!.content).toContain("return.stage=complete");
    return valid;
  } } });
  expect(result.map(row => row.turnId)).toEqual(["tn_01", "tn_02"]);
});
test("rejects omitted duplicate unknown turns, pending and text-only output", async () => {
  for (const summaries of [[summary("tn_01")], [summary("tn_01"), summary("tn_01")], [summary("tn_01"), summary("tn_03")], [summary("tn_01"), { ...summary("tn_02"), pending: [] }]]) {
    await expect(requestTurnSummaries({ ...input, provider: { complete: async () => ({ ...valid, toolCalls: [{ ...valid.toolCalls[0]!, arguments: { summaries } }] }) } })).rejects.toThrow();
  }
  await expect(requestTurnSummaries({ ...input, provider: { complete: async () => ({ ...valid, finish: "stop", toolCalls: [], content: JSON.stringify(valid.toolCalls[0]!.arguments) }) } })).rejects.toThrow();
});

test("provider faults and oversized escaped output cannot bypass private validation", async () => {
  const invalid = [
    { ...valid, missing: ["turnId"] },
    { ...valid, toolCalls: [{ ...valid.toolCalls[0]!, id: " " }] },
    { ...valid, toolCalls: [{ ...valid.toolCalls[0]!, arguments: { summaries: [{ ...summary("tn_01"), userRequest: "\u0001".repeat(1500), actions: "\u0001".repeat(2900) }, summary("tn_02")] } }] },
  ];
  for (const response of invalid) await expect(requestTurnSummaries({ ...input, provider: { complete: async () => response } })).rejects.toThrow();
});
