import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Provider } from "../../types.ts";
import { compressRecords } from "./index.ts";
import { compressionTurnsFromUserMessage } from "./protocol.ts";
import { archiveDir, loadIndex, readSource, resolveSources } from "../../context-archive/store.ts";
import type { CompressionTurn } from "./protocol.ts";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function setup(provider: Provider) {
  const dataDir = mkdtempSync(`${tmpdir()}/tchrome-compression-`); dirs.push(dataDir);
  return { dataDir, conversationId: "cv_test", repoRoot: resolve(import.meta.dir, "../../.."), provider, module: "conversationHistory" as const };
}
const source = (turnId: string, id = turnId, text = "保持状态，只改负责人") => ({ id, content: { turnId, userInput: { userInput: text }, goalChanges: [], toolIO: [], pageObservations: [], memoryWrites: [], output: null } });
function model(observe?: (turns: CompressionTurn[]) => void, body = "核对成功"): Provider {
  return { async complete(input) {
    const turns = compressionTurnsFromUserMessage(input.messages[1]!.content);
    observe?.(turns);
    return { finish: "tool_calls", content: "", toolCalls: [{ id: "summary", name: "submitTurnSummaries", arguments: { tag: "负责人／状态", actions: "修改负责人", result: body } }], attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [] };
  } };
}
test("sequential per-turn requests commit each success and keep independent immutable sources", async () => {
  const calls: CompressionTurn[][] = [];
  const args = setup(model(turns => calls.push(turns)));
  const records = [source("tn_01"), source("tn_02")];
  const progress: unknown[] = [];
  const outcome = await compressRecords({ ...args, records, onProgress: event => progress.push(event) });
  expect(outcome).toEqual({ status: "completed", committedTurnIds: ["tn_01", "tn_02"], totalTurns: 2 });
  expect(progress).toEqual([
    { type: "start", total: 2 },
    { type: "turn", completed: 1, total: 2, turnId: "tn_01" },
    { type: "turn", completed: 2, total: 2, turnId: "tn_02" },
  ]);
  expect(calls).toHaveLength(2);
  expect(calls[0]!.map(turn => turn.turnId)).toEqual(["tn_01"]);
  expect(calls[1]!.map(turn => turn.turnId)).toEqual(["tn_02"]);
  const first = loadIndex(args.dataDir, args.conversationId, args.module);
  expect(first.entries.map(record => record.id)).toEqual(["sum_01", "sum_02"]);
  expect(first.entries.map(record => record.turnId)).toEqual(["tn_01", "tn_02"]);
  expect(first.entries.map(record => record.userRequest)).toEqual(["保持状态，只改负责人", "保持状态，只改负责人"]);
  const again = await compressRecords({ ...args, records });
  expect(again.status).toBe("noop");
  expect(calls).toHaveLength(2);
  expect(resolveSources(args.dataDir, args.conversationId, args.module, first.activeIds)).toEqual(records);
});
test("new segments consolidate only their own turn with exact source ancestry", async () => {
  const args = setup(model());
  const first = source("tn_01", "segment_1");
  await compressRecords({ ...args, records: [first, source("tn_02")] });
  const initial = loadIndex(args.dataDir, args.conversationId, args.module);
  const last = source("tn_01", "segment_2", "最终确认");
  await compressRecords({ ...args, records: [last] });
  const next = loadIndex(args.dataDir, args.conversationId, args.module);
  expect(next.entries).toHaveLength(3);
  expect(next.activeIds).toEqual([next.entries[2]!.id, next.entries[1]!.id]);
  expect(next.entries[2]!.sourceIds).toEqual([initial.entries[0]!.id, "segment_2"]);
  expect(resolveSources(args.dataDir, args.conversationId, args.module, [next.entries[2]!.id])).toEqual([first, last]);
});
test("failed turn stops sequence: prefix stays covered, later turns keep originals", async () => {
  const good = model();
  const args = setup({ async complete(input) {
    const turns = compressionTurnsFromUserMessage(input.messages[1]!.content);
    if (turns[0]!.turnId === "tn_02") {
      return { finish: "tool_calls", content: "", toolCalls: [{ id: "summary", name: "submitTurnSummaries", arguments: { tag: "", actions: "a", result: "x" } }], attempts: 3, parseOk: true, schemaOk: false, faultCode: "schema_failed", missing: [] };
    }
    return good.complete(input);
  } });
  const records = [source("tn_01", "one"), source("tn_02", "two")];
  const progress: unknown[] = [];
  const outcome = await compressRecords({ ...args, records, onProgress: event => progress.push(event) });
  expect(outcome.status).toBe("stopped");
  expect(outcome.committedTurnIds).toEqual(["tn_01"]);
  expect(outcome.failedTurnId).toBe("tn_02");
  expect(outcome.totalTurns).toBe(2);
  expect(progress.at(-1)).toEqual({ type: "stopped", completed: 1, total: 2, failedTurnId: "tn_02" });
  expect(readSource(args.dataDir, args.conversationId, args.module, "one")).toEqual(records[0]);
  expect(readSource(args.dataDir, args.conversationId, args.module, "two")).toBeNull();
  const index = loadIndex(args.dataDir, args.conversationId, args.module);
  expect(index.coveredSourceIds).toEqual(["one"]);
  expect(index.activeIds).toEqual(["sum_01"]);
});
test("cancellation before any success commits nothing", async () => {
  const args = setup(model());
  await expect(compressRecords({ ...args, records: [source("tn_01")], isCancelled: () => true })).rejects.toThrow("cancelled");
  expect(readSource(args.dataDir, args.conversationId, args.module, "tn_01")).toBeNull();
  expect(loadIndex(args.dataDir, args.conversationId, args.module).entries).toEqual([]);
});
test("oversized string is sent whole in one request and archived unchanged", async () => {
  const calls: CompressionTurn[][] = [];
  const args = setup(model(turns => calls.push(turns)));
  const original = source("tn_01", "large", "起" + "\"\\\n文".repeat(60000) + "结束");
  expect(original.content.userInput.userInput.length).toBeGreaterThan(200000);
  await compressRecords({ ...args, records: [original] });
  expect(calls).toEqual([[original.content]]);
  expect(readSource(args.dataDir, args.conversationId, args.module, "large")).toEqual(original);
});
test("new sources merge only their own turn summaries; no sources skip model requests", async () => {
  const args = setup(model(undefined, "已验证".repeat(600)));
  await compressRecords({ ...args, records: [source("tn_01"), source("tn_02")] });
  const before = loadIndex(args.dataDir, args.conversationId, args.module);
  expect(before.entries).toHaveLength(2);
  const calls: CompressionTurn[][] = [];
  const segment = source("tn_01", "segment_2", "补充证据");
  await compressRecords({ ...args, provider: model(turns => calls.push(turns)), records: [segment] });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.map(turn => turn.turnId)).toEqual(["tn_01"]);
  expect(calls[0]![0]!.segments).toEqual([segment.content]);
  const next = loadIndex(args.dataDir, args.conversationId, args.module);
  await compressRecords({ ...args, provider: model(turns => calls.push(turns)), records: [segment] });
  await compressRecords({ ...args, provider: model(turns => calls.push(turns)), records: [] });
  expect(calls).toHaveLength(1);
  expect(next.entries.map(record => record.level)).toEqual([1, 1, 2]);
  expect(next.entries.slice(2).map(record => record.sourceIds)).toEqual([[before.entries[0]!.id, "segment_2"]]);
  expect(resolveSources(args.dataDir, args.conversationId, args.module, next.activeIds).map(record => record.id)).toEqual(["tn_01", "tn_02", "segment_2"]);
});

test("failed index commit never reuses an orphan summary ID on retry", async () => {
  const args = setup(model());
  const root = archiveDir(args.dataDir, args.conversationId, args.module);
  const indexPath = resolve(root, "index.json");
  const records = [source("tn_01")];
  await expect(compressRecords({ ...args, records, provider: model(() => mkdirSync(indexPath, { recursive: true })) })).rejects.toThrow();
  expect(existsSync(resolve(root, "records", "sum_01.json"))).toBe(true);
  rmSync(indexPath, { recursive: true });
  expect(loadIndex(args.dataDir, args.conversationId, args.module).entries).toEqual([]);
  await compressRecords({ ...args, records });
  const index = loadIndex(args.dataDir, args.conversationId, args.module);
  expect(index.activeIds).toEqual(["sum_02"]);
  expect(resolveSources(args.dataDir, args.conversationId, args.module, index.activeIds)).toEqual(records);
});
