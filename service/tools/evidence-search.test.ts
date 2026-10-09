import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "./execute.ts";
import { emptyLedger, ensureSession, loadLedger, primeActiveTask, loadReturnBlockIndex, saveFullReturn, saveReturnBlockIndex } from "../runtime/store.ts";
import { buildBlockIndex, readBlock } from "../evidence/index.ts";
import { appendAsset } from "../assets/catalog.ts";
import { handleTurn } from "../runtime/loop.ts";
import { applyToolEffects } from "../runtime/effects.ts";
import type { CompletionResult, Turn } from "../types.ts";
import { saveContextRecord } from "../runtime/records.ts";

const lookup = { knownTools: ["evidence_search"], enabledTools: ["evidence_search"], unusedTools: [] };
const fixture = async (run: (dataDir: string) => Promise<void>) => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-evidence-"));
  try { await run(dataDir); } finally { rmSync(dataDir, { recursive: true, force: true }); }
};
const query = async (dataDir: string, windows: unknown) => {
  const execution = await executeTool({ name: "evidence_search", arguments: { reason: "取证", windows }, dataDir, conversationId: "cv_01", browserNames: [], lookup });
  return { execution, ...JSON.parse(execution.text) };
};

test("root directory navigates to complete source blocks without re-externalization", () => fixture(async dataDir => {
  const full = Array.from({ length: 40 }, (_, i) => `function task${i}() { return "${"x".repeat(100)}"; }\n`).join("");
  saveFullReturn(dataDir, "cv_01", "call_01", full);
  saveReturnBlockIndex(dataDir, "cv_01", "call_01", buildBlockIndex(full, { maxChars: 500, path: "code.ts" }));
  const first = await query(dataDir, [{ callId: "call_01" }]);
  expect(first.results[0].kind).toBe("directory");
  const visit = async (blockId: string): Promise<string> => {
    const { results, execution } = await query(dataDir, [{ callId: "call_01", blockId }]);
    expect(execution.admitted).toBe(true);
    const row = results[0];
    if (row.kind === "content") return row.content;
    return (await Promise.all(row.children.map((child: { blockId: string }) => visit(child.blockId)))).join("");
  };
  expect(await visit(first.results[0].blockId)).toBe(full);
}));

test("search returns block references whose complete text comes from the immutable snapshot", () => fixture(async dataDir => {
  const full = 'export function useful() { return "needle and full expression"; }\n';
  saveFullReturn(dataDir, "cv_01", "call_01", full);
  const found = await query(dataDir, [{ callId: "call_01", keyword: "needle" }]);
  expect(found.results[0]).toMatchObject({ ok: true, kind: "search", totalMatches: 1 });
  const blockId = found.results[0].matches[0].blockId;
  writeFileSync(join(dataDir, "conversations/cv_01/returns/call_01.txt"), "changed source");
  const read = await query(dataDir, [{ callId: "call_01", blockId }]);
  expect(read.results[0]).toMatchObject({ kind: "content", content: full });
}));

test("call snapshots preserve unwrapped text and JSON values can be searched and read", () => fixture(async dataDir => {
  const full = JSON.stringify({ results: [{ path: "sample.ts", content: "const needle = 42;\n" }], text: "a".repeat(400) });
  saveFullReturn(dataDir, "cv_01", "call_01", full);
  expect(readFileSync(join(dataDir, "conversations/cv_01/returns/call_01.txt"), "utf8")).toBe(full);
  const found = await query(dataDir, [{ callId: "call_01", keyword: "needle" }]);
  expect(found.results[0].matches.length).toBeGreaterThan(0);
  const index = loadReturnBlockIndex(dataDir, "cv_01", "call_01")!;
  const blockId = found.results[0].matches[0].blockId;
  const expected = readBlock(index, blockId)!;
  const row = (await query(dataDir, [{ callId: "call_01", blockId }])).results[0];
  expect(row.kind).toBe(expected.kind);
  if (expected.kind === "content") expect(row.content).toBe(expected.content);
}));

test("page observations use the same search and complete block interface", () => fixture(async dataDir => {
  saveContextRecord(dataDir, "cv_01", "observation", { id: "page_01", result: { elements: [{ text: "target button" }] } });
  const found = await query(dataDir, [{ pageId: "page_01", keyword: "target" }]);
  expect(found.results[0]).toMatchObject({ ok: true, source: "page:page_01", kind: "search" });
  const read = await query(dataDir, [{ pageId: "page_01", blockId: found.results[0].matches[0].blockId }]);
  expect(read.results[0].kind).toBe("content");
  expect(read.results[0].content).toContain("target button");
}));

test("search pagination visits all matched blocks without clipping their content", () => fixture(async dataDir => {
  const full = Array.from({ length: 90 }, (_, i) => `needle_${i} ${"a".repeat(700)}\n\n`).join("");
  const index = buildBlockIndex(full, { maxChars: 1000 });
  saveFullReturn(dataDir, "cv_01", "call_01", full);
  saveReturnBlockIndex(dataDir, "cv_01", "call_01", index);
  let offset = 0;
  const ids = new Set<string>();
  let total = 0;
  do {
    const row = (await query(dataDir, [{ callId: "call_01", keyword: "needle", offset }])).results[0];
    expect(row.ok).toBe(true);
    total = row.totalMatches;
    for (const hit of row.matches) { expect(ids.has(hit.blockId)).toBe(false); ids.add(hit.blockId); }
    if (row.nextOffset === undefined) break;
    expect(row.nextOffset).toBeGreaterThan(offset);
    offset = row.nextOffset;
  } while (true);
  expect(offset).toBeGreaterThan(0);
  expect(ids.size).toBe(total);
}));

test("every requested window survives even when full blocks exceed the combined retrieval budget", () => fixture(async dataDir => {
  const windows = [];
  for (let i = 0; i < 8; i++) {
    const callId = `call_${i}`;
    const full = String(i).repeat(1500);
    const index = buildBlockIndex(full, { maxChars: 2000 });
    saveFullReturn(dataDir, "cv_01", callId, full);
    saveReturnBlockIndex(dataDir, "cv_01", callId, index);
    const root = readBlock(index, index.rootId)!;
    const blockId = root.kind === "content" ? root.blockId : root.children[0]!.blockId;
    windows.push({ callId, blockId });
  }
  const result = await query(dataDir, windows);
  expect(result.results).toHaveLength(8);
  for (let i = 0; i < 8; i++) expect(result.results[i].content).toBe(String(i).repeat(1500));
  expect(result.execution.admitted).toBe(true);
}));

test("missing source, unknown block and search misses return explicit failures", () => fixture(async dataDir => {
  saveFullReturn(dataDir, "cv_01", "call_01", "hello");
  const result = await query(dataDir, [{ callId: "call_missing" }, { callId: "call_01", blockId: "blk_missing" }, { callId: "call_01", keyword: "absent" }]);
  expect(result.ok).toBe(false);
  expect(result.results.map((row: { faultCode: string }) => row.faultCode)).toEqual(["file_not_found", "not_found", "not_found"]);
}));

test("invalid modes and removed parameters are rejected without coercion", () => fixture(async dataDir => {
  const invalid = [null, {}, { callId: "../secret" }, { callId: "call_01", pageId: "page_01" }, { callId: "call_01", keyword: " " }, { callId: "call_01", keyword: "a", blockId: "blk_01" }, { callId: "call_01", offset: 1 }, { callId: "call_01", keyword: "a", offset: "1" }, { callId: "call_01", keyword: "a", offset: -1 }, { callId: "call_01", levelId: "L1.1" }, { callId: "call_01", startLine: 1 }];
  for (const win of invalid) expect((await query(dataDir, [win])).results[0].faultCode).toBe("invalid_arguments");
  expect((await query(dataDir, [])).ok).toBe(false);
  expect((await query(dataDir, Array(9).fill({ callId: "call_01" }))).ok).toBe(false);
}));

const completion = (name: string, args: Record<string, unknown>): CompletionResult => ({
  finish: "tool_calls", content: "", attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [],
  toolCalls: [{ id: name, name, arguments: { reason: "验证块快照", ...args } }],
});

test("outline snapshot survives the full model loop and source edits before evidence retrieval", () => fixture(async dataDir => {
  primeActiveTask(dataDir);
  const conversationId = ensureSession(dataDir).conversationId;
  const file = join(dataDir, "source.ts");
  const original = Array.from({ length: 40 }, (_, i) => `export function feature${i}() { return "${"x".repeat(200)}"; }\n`).join("");
  writeFileSync(file, original);
  let step = 0, blockId = "", expected = "";
  const reply = await handleTurn({ dataDir, repoRoot: join(import.meta.dir, "../.."), provider: { complete: async input => {
    step++;
    if (step === 1) return completion("catalog_add", { names: ["local_fs_outline"] });
    if (step === 2) return completion("local_fs_outline", { path: file });
    const ledger = loadLedger(dataDir, conversationId);
    const outline = ledger.toolIO.find(row => row.name === "local_fs_outline")!;
    if (step === 3) {
      const shown = JSON.parse(outline.return.text);
      expect(shown.block.kind).toBe("directory");
      blockId = shown.block.children.find((child: { kind: string }) => child.kind === "content").blockId;
      expect(input.messages[1]!.content).toContain(blockId);
      const index = loadReturnBlockIndex(dataDir, conversationId, outline.callId)!;
      const block = readBlock(index, blockId)!;
      expect(block.kind).toBe("content");
      if (block.kind === "content") expected = block.content;
      expect(original).toContain(expected);
      writeFileSync(file, "export const changed = true;\n");
      return completion("evidence_search", { windows: [{ callId: outline.callId, blockId }] });
    }
    const evidence = ledger.toolIO.find(row => row.name === "evidence_search")!;
    const retrieved = JSON.parse(evidence.return.text);
    expect(retrieved.results[0]).toMatchObject({ kind: "content", blockId, content: expected });
    expect(retrieved.externalized).toBeUndefined();
    expect(input.messages[1]!.content).toContain("feature0");
    return completion("finishTurn", { text: "快照验证完成" });
  } } }, { userInput: "验证目录和快照", submittedAt: new Date().toISOString() });
  expect(reply.stopReason).toEqual({ kind: "reply", text: "快照验证完成" });
  expect(step).toBe(4);
  expect(expected.length).toBeGreaterThan(0);
}));

test("externalized observation directory IDs retrieve the exact archived page blocks", () => fixture(async dataDir => {
  const ledger = emptyLedger("cv_01");
  const turn: Turn = {
    turnId: "tn_01", conversationId: "cv_01", status: "inferring", createdAt: "now", completedAt: null,
    input: { id: "input_01", text: "观察", submittedAt: "now" }, stopReason: null,
    assembled: { baseToolsIds: [], toolIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], currentPage: null, currentTabs: { ok: true, windows: [] }, observations: [] },
  };
  const body = { elements: Array.from({ length: 100 }, (_, i) => ({ name: `button_${i}`, description: "text".repeat(60) })) };
  applyToolEffects({ dataDir, ledger, turn, call: { callId: "call_01", name: "observation_write", arguments: {}, batchId: "batch_01" }, effects: [{ type: "observation_write", observationType: "page_list_interactive_elements", tabId: 1, result: body }] });
  const observation = turn.assembled.observations[0]!;
  const shown = observation.result as { externalized: boolean; rootBlockId: string; directory: { blockId: string } };
  expect(shown.externalized).toBe(true);
  expect(shown.rootBlockId).toBe(shown.directory.blockId);
  const root = (await query(dataDir, [{ pageId: observation.id, blockId: shown.rootBlockId }])).results[0];
  expect(root.blockId).toBe(shown.rootBlockId);
  const found = (await query(dataDir, [{ pageId: observation.id, keyword: "button_50" }])).results[0];
  const fetched = await query(dataDir, [{ pageId: observation.id, blockId: found.matches[0].blockId }]);
  expect(fetched.results[0].kind).toBe("content");
  expect(fetched.results[0].content).toContain("button_50");
  expect(fetched.execution.admitted).toBe(true);
  const disk = JSON.parse(readFileSync(join(dataDir, "conversations/cv_01/context-records/observation", `${observation.id}.index.json`), "utf8"));
  expect(fetched.results[0].content).toBe((readBlock(disk, found.matches[0].blockId) as { content: string }).content);
  applyToolEffects({ dataDir, ledger, turn, call: { callId: "call_02", name: "observation_write", arguments: {}, batchId: "batch_02" }, effects: [{ type: "observation_write", observationType: "page_list_interactive_elements", tabId: 1, refresh: observation.id, result: { title: "refreshed-current-page" } }] });
  const refreshed = (await query(dataDir, [{ pageId: observation.id, keyword: "refreshed-current-page" }])).results[0];
  expect(refreshed.ok).toBe(true);
  const updated = (await query(dataDir, [{ pageId: observation.id, blockId: refreshed.matches[0].blockId }])).results[0];
  expect(updated.content).toContain("refreshed-current-page");
  expect(updated.content).not.toContain("button_50");
  expect((await query(dataDir, [{ pageId: observation.id, keyword: "button_50" }])).results[0].faultCode).toBe("not_found");
}));

test("asset_read navigates both independent text assets and call-backed snapshots", () => fixture(async dataDir => {
  const full = Array.from({ length: 60 }, (_, i) => `entry_${i}: ${"data ".repeat(40)}\n`).join("");
  saveFullReturn(dataDir, "cv_01", "call_01", full);
  const independentPath = "independent.txt";
  writeFileSync(join(dataDir, "conversations/cv_01", independentPath), full);
  for (const source of [{}, { callId: "call_01" }]) {
    const asset = appendAsset(dataDir, "cv_01", { name: "text", kind: "text", bytes: full.length, summary: "entries", source, path: independentPath });
    const read = async (args: Record<string, unknown>) => {
      const execution = await executeTool({ name: "asset_read", arguments: { reason: "取资产", assetId: asset.assetId, ...args }, dataDir, conversationId: "cv_01", browserNames: [], lookup });
      expect(execution.admitted).toBe(true);
      const parsed = JSON.parse(execution.text);
      return parsed.results ? parsed.results[0] : parsed;
    };
    const root = await read({});
    expect(root.kind).toBe("directory");
    const child = root.children.find((row: { kind: string }) => row.kind === "content");
    const block = await read({ blockId: child.blockId });
    expect(block.kind).toBe("content");
    expect(full).toContain(block.content);
    const found = await read({ keyword: "entry_50" });
    expect((await read({ blockId: found.matches[0].blockId })).content).toContain("entry_50");
  }
}));
