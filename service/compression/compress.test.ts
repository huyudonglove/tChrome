import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import type { Provider } from "../types.ts";
import { compressRecords } from "./compress.ts";
import { archiveDir, loadIndex, readSource, resolveSources } from "./store.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function setup(provider: Provider) {
  const dataDir = mkdtempSync(`${tmpdir()}/tchrome-compression-`); dirs.push(dataDir);
  return { dataDir, conversationId: "cv_test", repoRoot: resolve(import.meta.dir, "../.."), provider, module: "userInputHistory" as const };
}
function model(fn: (text: string) => string | Promise<string>): Provider {
  return { async complete(input) {
    expect(input.tools).toEqual([]);
    return { finish: "stop", content: await fn(input.messages[1]!.content), toolCalls: [], attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [] };
  } };
}
const output = (summary = "保留负责人要求和状态约束") => JSON.stringify({ tag: "任务负责人／状态限制", summary });

test("archives raw sources immutably, appends summaries and unfolds exact records", async () => {
  const args = setup(model(() => output()));
  const first = { id: "input_01", content: { userInput: "保持状态\n只改负责人", submittedAt: "2026-09-11" } };
  await compressRecords({ ...args, records: [first] });
  const initial = loadIndex(args.dataDir, args.conversationId, args.module);
  await compressRecords({ ...args, records: [first, { id: "input_02", content: "第二个要求" }] });
  const next = loadIndex(args.dataDir, args.conversationId, args.module);
  expect(next.entries).toHaveLength(2);
  expect(next.entries[0]).toEqual(initial.entries[0]);
  expect(next.coveredSourceIds).toEqual(["input_01", "input_02"]);
  expect(readSource(args.dataDir, args.conversationId, args.module, "input_01")).toEqual(first);
  expect(resolveSources(args.dataDir, args.conversationId, args.module, [...next.activeIds].reverse())).toEqual([first, { id: "input_02", content: "第二个要求" }]);
});

test("invalid output or cancellation never advances index or hides originals", async () => {
  const args = setup(model(() => output()));
  await compressRecords({ ...args, records: [{ id: "first", content: "原文" }] });
  const before = loadIndex(args.dataDir, args.conversationId, args.module);
  await expect(compressRecords({ ...args, provider: model(() => "not json"), records: [{ id: "second", content: "待归档" }] })).rejects.toThrow();
  let cancelled = false;
  await expect(compressRecords({ ...args, provider: model(() => { cancelled = true; return output(); }), records: [{ id: "second", content: "待归档" }], isCancelled: () => cancelled })).rejects.toThrow("cancelled");
  expect(loadIndex(args.dataDir, args.conversationId, args.module)).toEqual(before);
  expect(readSource(args.dataDir, args.conversationId, args.module, "second")).toBeNull();
});

test("threshold rollup retains lower levels and disjoint source coverage", async () => {
  const args = setup(model(() => output("关键内容".repeat(1800))));
  for (let i = 1; i <= 3; i++) await compressRecords({ ...args, records: [{ id: `input_${i}`, content: `要求 ${i}` }] });
  const index = loadIndex(args.dataDir, args.conversationId, args.module);
  expect(index.entries.map(record => record.level)).toEqual([1, 1, 1, 2]);
  expect(index.activeIds).toEqual([index.entries[3]!.id]);
  expect(index.entries[3]!.sourceIds).toEqual(index.entries.slice(0, 3).map(record => record.id));
  expect(resolveSources(args.dataDir, args.conversationId, args.module, index.activeIds).map(source => source.id)).toEqual(["input_1", "input_2", "input_3"]);
});

test("oversized single source sends all text parts and retains exact original", async () => {
  const texts: string[] = [];
  const args = setup(model(text => { texts.push(text); return output(); }));
  const source = { id: "large", content: "起" + "正文".repeat(40000) + "结束边界" };
  await compressRecords({ ...args, records: [source] });
  expect(texts.length).toBeGreaterThan(2);
  const chunks = texts.map(text => JSON.parse(text).data).filter(data => typeof data === "object" && "part" in data);
  expect(chunks.map(data => data.text).join("")).toEqual(JSON.stringify([source]));
  expect(texts.every(text => text.length < 61000)).toBe(true);
  expect(readSource(args.dataDir, args.conversationId, args.module, "large")).toEqual(source);
});

test("retries reuse complete orphan sources and ignore interrupted temporary writes", async () => {
  const args = setup(model(() => output()));
  const source = { id: "input_01", content: "完整原文" };
  const dir = join(archiveDir(args.dataDir, args.conversationId, args.module), "sources");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".input_01-crashed.tmp"), '{"id":');
  writeFileSync(join(dir, "input_01.json"), JSON.stringify(source, null, 2));
  await compressRecords({ ...args, records: [source] });
  expect(readSource(args.dataDir, args.conversationId, args.module, source.id)).toEqual(source);
  expect(readdirSync(dir).sort()).toEqual([".input_01-crashed.tmp", "input_01.json"]);
  expect(readFileSync(join(dir, "input_01.json"), "utf8")).toEqual(JSON.stringify(source, null, 2));
});

test("provider parsing failures reject even when content looks like valid JSON", async () => {
  const good = model(() => output());
  const args = setup({ async complete(input) { return { ...await good.complete(input), parseOk: false }; } });
  await expect(compressRecords({ ...args, records: [{ id: "input_01", content: "原文" }] })).rejects.toThrow("parse_failed");
  expect(loadIndex(args.dataDir, args.conversationId, args.module).coveredSourceIds).toEqual([]);
});
