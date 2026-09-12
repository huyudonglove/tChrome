import { afterAll, expect, test } from "bun:test";
import { resolve, join } from "node:path";
import { requestTurnSummaries } from "./protocol.ts";
import type { CompletionResult } from "../../types.ts";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
const dataDir = mkdtempSync(join(tmpdir(), "compression-protocol-"));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
const repoRoot = resolve(import.meta.dir, "../../..");
const summary = (turnId: string) => ({ turnId, tag: "负责人", userRequest: "改负责人", actions: "修改并核对", result: "状态未变" });
const valid: CompletionResult = { finish: "tool_calls", content: "忽略正文", toolCalls: [{ id: "result", name: "submitTurnSummaries", arguments: { summaries: [summary("tn_02"), summary("tn_01")] } }], attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [] };
const input = { dataDir, conversationId: "cv_01", repoRoot, turns: [{ turnId: "tn_01", toolIO: [] }, { turnId: "tn_02", toolIO: [] }] };
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

test("compression logs preserve request and invalid response with precise validation errors", async () => {
  const conversationId = "cv_02";
  const bad = { ...valid, toolCalls: [{ ...valid.toolCalls[0]!, arguments: { summaries: [{ ...summary("tn_01"), actions: true }] } }] };
  await expect(requestTurnSummaries({ ...input, conversationId, provider: { complete: async () => bad } })).rejects.toThrow("compression log:");
  const dir = join(dataDir, "conversations", conversationId, "agent-logs", "compression");
  const rows = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(rows.map(row => row.stage)).toEqual(["start", "request", "response", "validation-error", "error"]);
  expect(JSON.parse(rows[1].data.messages[1].content)).toEqual({ turns: input.turns });
  expect(rows[1].data.tools[0].function.name).toBe("submitTurnSummaries");
  expect(rows[2].data).toEqual(bad);
  expect(rows[3].data.errors).toContainEqual(expect.objectContaining({ instancePath: "/summaries/0/actions", keyword: "type" }));
});

test("compression request is persisted before provider failure and success is logged separately", async () => {
  const conversationId = "cv_03";
  await expect(requestTurnSummaries({ ...input, conversationId, provider: { complete: async () => { throw new Error("network unavailable"); } } })).rejects.toThrow("network unavailable");
  await requestTurnSummaries({ ...input, conversationId, provider: { complete: async () => valid } });
  const dir = join(dataDir, "conversations", conversationId, "agent-logs", "compression");
  const logs = readdirSync(dir).map(file => readFileSync(join(dir, file), "utf8").trim().split("\n").map(line => JSON.parse(line)));
  expect(logs).toHaveLength(2);
  expect(logs.find(rows => rows.at(-1).stage === "error")!.map(row => row.stage)).toEqual(["start", "request", "error"]);
  expect(logs.find(rows => rows.at(-1).stage === "complete")!.map(row => row.stage)).toEqual(["start", "request", "response", "complete"]);
});
