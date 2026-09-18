import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestTurnSummaries } from "./protocol.ts";
import { compressionSystemPrompt, compressionUserPrompt } from "./protocol.ts";
import type { CompletionResult } from "../../types.ts";
import { readdirSync, readFileSync } from "node:fs";
const dataDir = mkdtempSync(join(tmpdir(), "compression-protocol-"));
// afterAll cleanup at end via process exit acceptable for suite; keep dir unique
const repoRoot = resolve(import.meta.dir, "../../..");
const summary = (turnId: string) => ({ turnId, tag: "负责人", userRequest: "改负责人", actions: "修改并核对", result: "状态未变" });
const valid: CompletionResult = { finish: "tool_calls", content: "忽略正文", toolCalls: [{ id: "result", name: "submitTurnSummaries", arguments: { summaries: [summary("tn_02"), summary("tn_01")] } }], attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [] };
const input = { dataDir, conversationId: "cv_01", repoRoot, turns: [{ turnId: "tn_01", toolIO: [] }, { turnId: "tn_02", toolIO: [] }] };

test("compression uses dedicated context system/user with registry-generated fields", () => {
  const system = compressionSystemPrompt(repoRoot);
  expect(system).toContain("<compressionRole>");
  expect(system).toContain("<compressionModules>");
  expect(system).toContain("modules.json");
  expect(system).toContain("- toolIO:");
  expect(system).toContain("submitTurnSummaries");
  const user = compressionUserPrompt(repoRoot, input.turns);
  expect(user).toContain("<compressionTurns>");
  expect(user).toContain(JSON.stringify({ turns: input.turns }));
});

test("private submission returns exact turn coverage in source order without extra length gates", async () => {
  const result = await requestTurnSummaries({ ...input, provider: { complete: async request => {
    expect(request.tools.map(tool => tool.function.name)).toEqual(["submitTurnSummaries"]);
    expect(request.messages[0]!.content).toContain("<compressionRole>");
    expect(request.messages[1]!.content).toContain(JSON.stringify({ turns: input.turns }));
    return { ...valid, toolCalls: [{ ...valid.toolCalls[0]!, arguments: { summaries: [{ ...summary("tn_02"), result: "x".repeat(13000) }, summary("tn_01")] } }] };
  } } });
  expect(result.map(row => row.turnId)).toEqual(["tn_01", "tn_02"]);
  expect(result[1]!.result).toBe("x".repeat(13000));
});
test("format errors return to the model for self-repair up to three attempts", async () => {
  let calls = 0;
  const stringified = { ...valid, toolCalls: [{ ...valid.toolCalls[0]!, arguments: { summaries: JSON.stringify([summary("tn_02"), summary("tn_01")]) } }] };
  const result = await requestTurnSummaries({ ...input, provider: { complete: async request => {
    calls++;
    expect(request.messages.at(-1)!.role).toBe("user");
    if (calls < 3) return stringified;
    expect(JSON.parse(request.messages.at(-1)!.content)).toMatchObject({ selfRepair: true, attempt: 3 });
    return valid;
  } } });
  expect(calls).toBe(3);
  expect(result.map(row => row.turnId)).toEqual(["tn_01", "tn_02"]);
});
test("rejects omitted duplicate unknown turns, pending and text-only output after three attempts", async () => {
  for (const summaries of [[summary("tn_01")], [summary("tn_01"), summary("tn_01")], [summary("tn_01"), summary("tn_03")], [summary("tn_01"), { ...summary("tn_02"), pending: [] }]]) {
    let calls = 0;
    await expect(requestTurnSummaries({ ...input, provider: { complete: async () => { calls++; return { ...valid, toolCalls: [{ ...valid.toolCalls[0]!, arguments: { summaries } }] }; } } })).rejects.toThrow();
    expect(calls).toBe(3);
  }
  await expect(requestTurnSummaries({ ...input, provider: { complete: async () => ({ ...valid, finish: "stop", toolCalls: [], content: JSON.stringify(valid.toolCalls[0]!.arguments) }) } })).rejects.toThrow();
});

test("provider faults and empty output cannot bypass private validation", async () => {
  const invalid = [
    { ...valid, missing: ["turnId"] },
    { ...valid, toolCalls: [{ ...valid.toolCalls[0]!, id: " " }] },
    { ...valid, toolCalls: [{ ...valid.toolCalls[0]!, arguments: { summaries: [{ ...summary("tn_01"), userRequest: " ", actions: "" }, summary("tn_02")] } }] },
  ];
  for (const response of invalid) {
    let calls = 0;
    await expect(requestTurnSummaries({ ...input, provider: { complete: async () => { calls++; return response; } } })).rejects.toThrow();
    expect(calls).toBe(3);
  }
});

test("compression logs preserve request and invalid response with precise validation errors", async () => {
  const conversationId = "cv_02";
  const bad = { ...valid, toolCalls: [{ ...valid.toolCalls[0]!, arguments: { summaries: [{ ...summary("tn_01"), actions: true }] } }] };
  await expect(requestTurnSummaries({ ...input, conversationId, provider: { complete: async () => bad } })).rejects.toThrow("compression log:");
  const dir = join(dataDir, "conversations", conversationId, "agent-logs", "compression");
  const rows = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const stages = rows.map(row => row.stage);
  expect(stages[0]).toBe("start");
  expect(stages.filter(stage => stage === "validation-error")).toHaveLength(3);
  expect(stages.at(-1)).toBe("error");
  const req = rows.find(row => row.stage === "request");
  expect(req.data.messages[0].content).toContain("<compressionRole>");
  expect(req.data.tools[0].function.name).toBe("submitTurnSummaries");
  expect(rows.find(row => row.stage === "validation-error").data.errors).toContainEqual(expect.objectContaining({ instancePath: "/summaries/0/actions", keyword: "type" }));
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

test("compression preserves provider fault codes through log wrapping", async () => {
  for (const faultCode of ["provider_key_invalid", "provider_output_limit", "stopped"]) {
    let calls = 0;
    await expect(requestTurnSummaries({ ...input, provider: { complete: async () => { calls++; return { ...valid, finish: "error", faultCode }; } } }))
      .rejects.toMatchObject({ faultCode, message: expect.stringContaining("compression log:"), cause: expect.objectContaining({ faultCode }) });
    expect(calls).toBe(1);
  }
  let emptyCalls = 0;
  await expect(requestTurnSummaries({ ...input, provider: { complete: async () => { emptyCalls++; return { ...valid, toolCalls: [] }; } } }))
    .rejects.toMatchObject({ faultCode: "compression_failed" });
  expect(emptyCalls).toBe(3);
  let coverageCalls = 0;
  await expect(requestTurnSummaries({ ...input, provider: { complete: async () => { coverageCalls++; return { ...valid, toolCalls: [{ ...valid.toolCalls[0]!, arguments: { summaries: [] } }] }; } } }))
    .rejects.toMatchObject({ faultCode: "compression_failed" });
  expect(coverageCalls).toBe(3);
});

test("unavailable compression logs cannot replace a provider failure", async () => {
  const conversationId = "cv_log_removed";
  const dir = join(dataDir, "conversations", conversationId, "agent-logs", "compression");
  await expect(requestTurnSummaries({ ...input, conversationId, provider: { complete: async () => {
    rmSync(dir, { recursive: true, force: true });
    return { ...valid, finish: "error", faultCode: "provider_key_invalid" };
  } } })).rejects.toMatchObject({ faultCode: "provider_key_invalid" });
});
