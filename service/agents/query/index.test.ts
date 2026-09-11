import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { commitArchive } from "../../context-archive/store.ts";
import { queryContext } from "./index.ts";
import type { CompressionRecord, SourceRecord } from "../../context-archive/types.ts";
import type { Provider } from "../../types.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const repoRoot = resolve(import.meta.dir, "../../..");
function fixture(contents: unknown[] = [{ id: "raw_0", turnId: "tn_0", userInput: "只改负责人", submittedAt: "2026-09-01" }, { id: "raw_1", userInput: "状态保持待处理" }]) {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-query-")); dirs.push(dataDir);
  const sources: SourceRecord[] = contents.map((content, i) => ({ id: `raw_${i}`, content: { ...(content as Record<string, unknown>), turnId: `tn_${i}` } }));
  const records: CompressionRecord[] = sources.map((source, i) => ({ id: `sum_${i}`, module: "conversationHistory", level: 1,
    turnId: `tn_${i}`, tag: "修改限制", userRequest: "关于修改负责人和状态的限制", actions: "检查负责人", result: "完成核对", sourceIds: [source.id], createdAt: `2026-09-0${i + 1}` }));
  if (records.length > 1) records.push({ id: "sum_parent", module: "conversationHistory", level: 2, turnId: "tn_0", tag: "修改限制", userRequest: "历史修改规则", actions: "检查", result: "已核对",
    sourceIds: [records[0]!.id], createdAt: "2026-09-09" });
  commitArchive(dataDir, "cv_test", { version: 1, module: "conversationHistory", entries: records,
    activeIds: records.length > 1 ? ["sum_parent", ...records.filter(r => r.level === 1 && r.id !== "sum_0").map(r => r.id)] : records.map(r => r.id), coveredSourceIds: sources.map(s => s.id) }, sources, records);
  return { dataDir, conversationId: "cv_test", module: "conversationHistory" as const, tag: "任务的修改限制", repoRoot };
}
function providerFor(ids: string[], observe?: (input: Parameters<Provider["complete"]>[0]) => void): Provider {
  return { async complete(input) { observe?.(input); return { finish: "tool_calls", content: "", toolCalls: [{ id: "call_matches", name: "submitMatches", arguments: { ids } }], attempts: 1,
    parseOk: true, schemaOk: true, faultCode: null, missing: [] }; } };
}

test("query validates candidates against module directory and does not expose partial matches after invalid output", async () => {
  const input = fixture();
  const result = await queryContext({ ...input, provider: providerFor(["sum_0", "../outside"]) });
  expect(result.status).toBe("error");
  expect(result.contents).toEqual([]);
  expect((await queryContext({ ...input, module: "toolIO" as never, provider: providerFor(["sum_0"]) })).status).toBe("error");
});

test("empty semantic match is not_found and cancellation prevents calls", async () => {
  const input = fixture();
  expect((await queryContext({ ...input, provider: providerFor([]) })).status).toBe("not_found");
  expect((await queryContext({ ...input, isCancelled: () => true, provider: providerFor([], () => { throw new Error("must not call"); }) })).status).toBe("cancelled");
});

test("large original returns explicit partial with complete prefix and does not clip or skip", async () => {
  const input = fixture([{ userInput: "first" }, { userInput: "x".repeat(31000) }, { userInput: "last" }]);
  const result = await queryContext({ ...input, provider: providerFor(["sum_parent", "sum_1", "sum_2"]) });
  expect(result).toMatchObject({ ok: true, status: "partial", contents: [{ userInput: "first" }], matchedRecords: 3, omittedRecords: 2 });
});

test("directory batches are bounded and all batches are queried before declaring no matches", async () => {
  const input = fixture(Array.from({ length: 300 }, (_, i) => ({ userInput: `record ${i}` })));
  let calls = 0;
  const provider = providerFor([], request => {
    calls++;
    const payload = JSON.parse(request.messages[1]!.content);
    expect(JSON.stringify(payload.catalog).length).toBeLessThanOrEqual(24000);
  });
  const result = await queryContext({ ...input, provider });
  expect(result.status).toBe("not_found");
  expect(calls).toBeGreaterThan(1);
});

test("later directory failure does not return earlier candidates as complete results", async () => {
  const input = fixture(Array.from({ length: 300 }, (_, i) => ({ userInput: `record ${i}` })));
  let calls = 0;
  const provider: Provider = { async complete(request) {
    calls++;
    if (calls === 2) throw new Error("provider unavailable");
    const entries = JSON.parse(request.messages[1]!.content).catalog;
    return { finish: "tool_calls", content: "", toolCalls: [{ id: "call_matches", name: "submitMatches", arguments: { ids: [entries[0].id] } }], attempts: 1,
      parseOk: true, schemaOk: true, faultCode: null, missing: [] };
  } };
  const result = await queryContext({ ...input, provider });
  expect(result.status).toBe("error");
  expect(result.contents).toEqual([]);
  expect(calls).toBe(2);
});

test("query preserves per-turn modules, operational target IDs and historical outcomes", async () => {
  const input = fixture([
    { conversationId: "cv_test", turnId: "tn_0", sequence: { turn: 0, batch: 0 }, segment: { complete: false, batchIds: ["batch_private"] }, status: "failed", userInput: { id: "input_0", turnId: "tn_0", userInput: "只改负责人" },
      goalChanges: [{ id: "goal_0", turnId: "tn_0", goal: "修改负责人" }],
      toolIO: [{ callId: "call_0", turnId: "tn_0", name: "page.click", arguments: { id: "e1", ref: "el_target" }, return: { text: "original full text", id: "result_id" } }],
      pageObservations: [{ id: "page_0", turnId: "tn_0", tab: 42, description: "状态异常" }],
      memoryWrites: [{ memoryId: "mem_0", turnId: "tn_0", text: "保持状态" }], output: { type: "error", error: "保存失败" } },
    { turnId: "tn_1", status: "completed", userInput: { id: "input_1", userInput: "修复状态" }, goalChanges: [], toolIO: [], pageObservations: [], memoryWrites: [], output: { type: "reply", text: "已修复" } },
  ]);
  const result = await queryContext({ ...input, provider: providerFor(["sum_1", "sum_parent", "sum_0"], request => {
    expect(request.tools.map(tool => tool.function.name)).toEqual(["submitMatches"]);
    expect(JSON.parse(request.messages[1]!.content).request).toMatchObject({ module: "conversationHistory", tag: input.tag });
  }) });
  expect(result.status).toBe("complete");
  expect(result.contents).toEqual([
    { segment: { complete: false }, status: "failed", userInput: { userInput: "只改负责人" }, goalChanges: [{ goal: "修改负责人" }],
      toolIO: [{ name: "page.click", arguments: { id: "e1", ref: "el_target" }, return: { text: "original full text", id: "result_id" } }],
      pageObservations: [{ tab: 42, description: "状态异常" }], memoryWrites: [{ text: "保持状态" }], output: { type: "error", error: "保存失败" } },
    { status: "completed", userInput: { userInput: "修复状态" }, goalChanges: [], toolIO: [], pageObservations: [], memoryWrites: [], output: { type: "reply", text: "已修复" } },
  ]);
  expect(result.detail).toContain("不是当前待办");
});
