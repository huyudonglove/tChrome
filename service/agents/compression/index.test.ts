import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Provider } from "../../types.ts";
import { compressRecords } from "./index.ts";
import { loadIndex, readSource, resolveSources } from "../../context-archive/store.ts";
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
    const { turns } = JSON.parse(input.messages[1]!.content) as { turns: CompressionTurn[] };
    observe?.(turns);
    return { finish: "tool_calls", content: "", toolCalls: [{ id: "summary", name: "submitTurnSummaries", arguments: { summaries: turns.map(({ turnId }) => ({ turnId, tag: "负责人／状态", userRequest: "保持状态", actions: "修改负责人", result: body })) } }], attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [] };
  } };
}
test("batches turns in one request and preserves independent immutable sources", async () => {
  const calls: CompressionTurn[][] = [];
  const args = setup(model(turns => calls.push(turns)));
  const records = [source("tn_01"), source("tn_02")];
  await compressRecords({ ...args, records });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.map(turn => turn.turnId)).toEqual(["tn_01", "tn_02"]);
  const first = loadIndex(args.dataDir, args.conversationId, args.module);
  expect(first.entries.map(record => record.sourceIds)).toEqual([["tn_01"], ["tn_02"]]);
  await compressRecords({ ...args, records });
  expect(calls).toHaveLength(1);
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
test("invalid later batch or cancellation never advances any coverage", async () => {
  let calls = 0;
  const good = model();
  const args = setup({ async complete(input) { const response = await good.complete(input); return ++calls === 2 ? { ...response, parseOk: false } : response; } });
  await expect(compressRecords({ ...args, records: [source("tn_01", "one", "x".repeat(40000)), source("tn_02", "two", "x".repeat(40000))] })).rejects.toThrow("parse_failed");
  expect(loadIndex(args.dataDir, args.conversationId, args.module).entries).toEqual([]);
  let cancelled = false;
  await expect(compressRecords({ ...args, provider: model(() => { cancelled = true; }), records: [source("tn_01")], isCancelled: () => cancelled })).rejects.toThrow("cancelled");
  expect(readSource(args.dataDir, args.conversationId, args.module, "tn_01")).toBeNull();
});
test("oversized string retains every character across typed field fragments", async () => {
  const calls: CompressionTurn[][] = [];
  const args = setup(model(turns => calls.push(turns)));
  const original = source("tn_01", "large", "起" + "\"\\\n文".repeat(30000) + "结束");
  await compressRecords({ ...args, records: [original] });
  const fragments = calls.flat().filter(turn => turn.fragment).map(turn => turn.fragment as { path: string[]; offset?: number; value: unknown });
  const textParts = fragments.filter(part => part.path.join(".") === "userInput.userInput");
  expect(textParts.map(part => part.value).join("")).toEqual(original.content.userInput.userInput);
  expect(calls.every(turns => JSON.stringify({ turns }).length <= 60000)).toBe(true);
  expect(readSource(args.dataDir, args.conversationId, args.module, "large")).toEqual(original);
});
test("rollup has no independent threshold and explicit pass keeps turns separate", async () => {
  const args = setup(model(undefined, "已验证".repeat(600)));
  await compressRecords({ ...args, records: [source("tn_01"), source("tn_02")] });
  const before = loadIndex(args.dataDir, args.conversationId, args.module);
  expect(before.entries).toHaveLength(2);
  await compressRecords({ ...args, provider: model(), records: [], recompress: true });
  const next = loadIndex(args.dataDir, args.conversationId, args.module);
  expect(next.entries.map(record => record.level)).toEqual([1, 1, 2, 2]);
  expect(next.entries.slice(2).map(record => record.sourceIds)).toEqual(before.entries.map(record => [record.id]));
  expect(resolveSources(args.dataDir, args.conversationId, args.module, next.activeIds).map(record => record.id)).toEqual(["tn_01", "tn_02"]);
});
