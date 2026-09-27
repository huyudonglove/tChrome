import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "./execute.ts";
import { applyToolEffects } from "../runtime/effects.ts";
import { emptyLedger, loadTurn, saveFullReturn, saveReturnIndexTree } from "../runtime/store.ts";
import { buildLevels, retrievalWindowChars } from "../admission.ts";
import { saveContextRecord, loadContextRecord } from "../runtime/records.ts";
import { runtimeConfig } from "../config/runtime.ts";
import type { Turn } from "../types.ts";

const lookup = { knownTools: ["evidence.search", "page.clear_result"], enabledTools: ["evidence.search"], unusedTools: [] };

test("evidence.search returns default ±2000 context around keyword from cached call return", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-evidence-search-"));
  try {
    const body = `${"x".repeat(2500)}NEEDLE_IN_HAYSTACK${"y".repeat(2500)}`;
    saveFullReturn(dataDir, "cv_01", "call_09", body);
    const execution = await executeTool({
      name: "evidence.search",
      arguments: { reason: "查关键字", windows: [{ callId: "call_09", keyword: "NEEDLE_IN_HAYSTACK" }] },
      dataDir,
      conversationId: "cv_01",
      lookup,
    });
    const parsed = JSON.parse(execution.text) as { ok: boolean; results: Record<string, unknown>[] };
    const row = parsed.results[0]! as Record<string, unknown>;
    expect(row.ok).toBe(true);
    expect(row.mode).toBe("search");
    expect(row.matchCount).toBe(1);
    expect(row.path).toBe(join(dataDir, "conversations", "cv_01", "returns", "call_09.txt"));
    expect(row.lineWidth).toBe(runtimeConfig.results.lineWidth);
    expect(row.totalLines).toBe(Math.ceil(body.length / runtimeConfig.results.lineWidth));
    expect((row.matches as { hit: string; lineStart: number; lineEnd: number; before: string; after: string }[])[0]!.hit).toBe("NEEDLE_IN_HAYSTACK");
    expect((row.matches as { lineStart: number }[])[0]!.lineStart).toBeGreaterThan(0);
    expect((row.matches as { lineStart: number; lineEnd: number }[])[0]!.lineEnd).toBeGreaterThanOrEqual((row.matches as { lineStart: number }[])[0]!.lineStart);
    // contextChars 现在是「本次取回总额」：单条命中的 before+hit+after 不超过 retrievalWindowChars。
    const firstMatch = (row.matches as { hit: string; before: string; after: string }[])[0]!;
    expect(firstMatch.before.length).toBeGreaterThan(0);
    expect(firstMatch.after.length).toBeGreaterThan(0);
    expect(firstMatch.before.length + firstMatch.hit.length + firstMatch.after.length)
      .toBeLessThanOrEqual(retrievalWindowChars());
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("cached returns are line-wrapped on disk at lineWidth", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-evidence-wrap-"));
  try {
    const width = runtimeConfig.results.lineWidth;
    const body = "a".repeat(width * 2 + 10);
    saveFullReturn(dataDir, "cv_01", "call_wrap", body);
    const file = readFileSync(join(dataDir, "conversations", "cv_01", "returns", "call_wrap.txt"), "utf8");
    const lines = file.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toHaveLength(width);
    expect(lines[1]).toHaveLength(width);
    expect(lines[2]).toHaveLength(10);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("evidence.search lines mode reads from startLine within the searchContextChars window", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-evidence-lines-"));
  try {
    const width = runtimeConfig.results.lineWidth;
    const body = Array.from({ length: 30 }, (_, i) => String(i + 1).padStart(width, `${(i + 1) % 10}`)).join("");
    saveFullReturn(dataDir, "cv_01", "call_lines", body);
    const execution = await executeTool({
      name: "evidence.search",
      arguments: { reason: "按行读", windows: [{ callId: "call_lines", startLine: 3 }] },
      dataDir,
      conversationId: "cv_01",
      lookup,
    });
    const parsed = JSON.parse(execution.text) as { ok: boolean; results: Record<string, unknown>[] };
    const row = parsed.results[0]! as Record<string, unknown>;
    expect(row.ok).toBe(true);
    expect(row.mode).toBe("lines");
    expect(row.totalLines).toBe(30);
    expect(row.startLine).toBe(3);
    // Same default window as keyword search: searchContextChars chars → ~20 full lines at width 100.
    expect(row.endLine).toBe(22);
    expect((row.lines as { line: number }[]).map((item) => item.line)).toEqual(Array.from({ length: 20 }, (_, i) => i + 3));
    expect((row.lines as { text: string }[])[0]!.text).toHaveLength(width);
    const textLen = (row.lines as { text: string }[]).reduce((sum, item) => sum + item.text.length, 0);
    expect(textLen).toBeLessThanOrEqual(runtimeConfig.results.searchContextChars);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("evidence.search allows keyword with startLine as hybrid and rejects blank modes", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-evidence-mode-"));
  try {
    saveFullReturn(dataDir, "cv_01", "call_01", "hello world");
    const hybrid = await executeTool({
      name: "evidence.search",
      arguments: { reason: "x", windows: [{ callId: "call_01", keyword: "hello", startLine: 1 }] },
      dataDir, conversationId: "cv_01", lookup,
    });
    const hybridParsed = JSON.parse(hybrid.text) as { ok: boolean; results: Record<string, unknown>[] };
    expect(hybridParsed.results[0]).toMatchObject({ ok: true, mode: "hybrid", matchCount: 1 });
    const blank = await executeTool({
      name: "evidence.search",
      arguments: { reason: "x", windows: [{ callId: "call_01" }] },
      dataDir, conversationId: "cv_01", lookup,
    });
    expect(JSON.parse(blank.text)).toMatchObject({ ok: false, results: [{ ok: false, faultCode: "invalid_arguments" }] });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("evidence.search reads page observation archive and returns file path", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-evidence-search-page-"));
  try {
    const huge = { ok: true, tabId: 1, elements: [{ name: "alpha-target-omega" }], blob: "z".repeat(8000) };
    saveContextRecord(dataDir, "cv_01", "observation", {
      id: "page_01", turnId: "tn_01", callId: "call_01", tabId: 1,
      type: "page.list_interactive_elements", result: huge, observedAt: new Date().toISOString(),
    });
    const execution = await executeTool({
      name: "evidence.search",
      arguments: { reason: "查元素", windows: [{ pageId: "page_01", keyword: "alpha-target" }] },
      dataDir,
      conversationId: "cv_01",
      lookup,
    });
    const parsed = JSON.parse(execution.text) as { ok: boolean; results: Record<string, unknown>[] };
    const row = parsed.results[0]! as Record<string, unknown>;
    expect(row.ok).toBe(true);
    expect(row.source).toBe("page:page_01");
    expect(row.path).toContain("context-records/observation/page_01.json");
    expect((row.matches as { hit: string }[])[0]!.hit).toBe("alpha-target");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("evidence.search returns one result per window and keeps per-item ok", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-evidence-multi-"));
  try {
    saveFullReturn(dataDir, "cv_01", "call_a", "alpha NEEDLE beta");
    saveFullReturn(dataDir, "cv_01", "call_b", "gamma DELTA epsilon");
    const execution = await executeTool({
      name: "evidence.search",
      arguments: {
        reason: "两段一起读",
        windows: [
          { callId: "call_a", keyword: "NEEDLE" },
          { callId: "call_b", startLine: 1 },
          { callId: "call_missing", keyword: "x" },
        ],
      },
      dataDir,
      conversationId: "cv_01",
      lookup,
    });
    const parsed = JSON.parse(execution.text) as { ok: boolean; results: Record<string, unknown>[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.results).toHaveLength(3);
    expect(parsed.results[0]).toMatchObject({ ok: true, mode: "search", matchCount: 1 });
    expect(parsed.results[1]).toMatchObject({ ok: true, mode: "lines" });
    expect(parsed.results[2]).toMatchObject({ ok: false, faultCode: "file_not_found" });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("oversized observation.write result is externalized with path and totalLines; full archive remains", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-ext-page-"));
  try {
    const ledger = emptyLedger("cv_ext");
    ledger.status = "running";
    ledger.active = { turnId: "tn_01" };
    const turn: Turn = {
      turnId: "tn_01", conversationId: "cv_ext", status: "inferring",
      createdAt: new Date().toISOString(), completedAt: null,
      input: { id: "input_01", text: "大结果", submittedAt: "now" },
      stopReason: null, goalChanges: [],
      assembled: {
        baseToolsIds: [], toolIds: [],
        conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [],
        currentPage: null, currentTabs: { ok: true, windows: [] }, observations: [],
      },
    };
    const bigResult = { ok: true, tabId: 7, url: "https://example.com", title: "T", blob: "b".repeat(runtimeConfig.results.inlineChars + 50) };
    applyToolEffects({
      dataDir, ledger, turn,
      call: { callId: "call_big", name: "observation.write", batchId: "batch_01", arguments: {} },
      effects: [{
        type: "observation.write",
        observationType: "page.list_interactive_elements",
        result: bigResult,
        tabId: 7,
      }],
    });
    const windowRow = turn.assembled.observations[0]!;
    expect(windowRow.result).toMatchObject({ ok: true, externalized: true, type: "page.list_interactive_elements" });
    const stub = windowRow.result as any;
    expect(stub.message).toContain("evidence.search");
    expect(stub.path).toContain("observation");
    expect(stub.lineWidth).toBe(runtimeConfig.results.lineWidth);
    expect(stub.totalLines).toBe(Math.ceil(stub.totalChars / runtimeConfig.results.lineWidth));
    expect(stub.preview).toBeUndefined();
    expect(String(stub.summary).length).toBeGreaterThan(0);
    const archived = JSON.parse(loadContextRecord(dataDir, "cv_ext", "observation", windowRow.id)!);
    expect(archived.result.blob.length).toBe(runtimeConfig.results.inlineChars + 50);
    const textPath = join(dataDir, "conversations", "cv_ext", "context-records", "observation", `${windowRow.id}.txt`);
    const wrapped = readFileSync(textPath, "utf8");
    expect(wrapped.split("\n").length).toBe(stub.totalLines);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("evidence.search rejects missing sources and blank keywords", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-evidence-search-bad-"));
  try {
    const missing = await executeTool({
      name: "evidence.search",
      arguments: { reason: "x", windows: [{ callId: "call_missing", keyword: "abc" }] },
      dataDir, conversationId: "cv_01", lookup,
    });
    expect(JSON.parse(missing.text)).toMatchObject({ ok: false, results: [{ ok: false, faultCode: "file_not_found" }] });
    const blank = await executeTool({
      name: "evidence.search",
      arguments: { reason: "x", windows: [{ callId: "call_01", keyword: "  " }] },
      dataDir, conversationId: "cv_01", lookup,
    });
    expect(JSON.parse(blank.text)).toMatchObject({ ok: false, results: [{ ok: false, faultCode: "invalid_arguments" }] });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("evidence.search finds keyword split across wrap newlines", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-evidence-wrap-kw-"));
  try {
    const width = runtimeConfig.results.lineWidth;
    // Force NEEDLE to straddle the fixed-width wrap boundary.
    const pad = "A".repeat(width - 3);
    const body = `${pad}NEEDLE${"B".repeat(50)}`;
    saveFullReturn(dataDir, "cv_01", "call_kw", body);
    const execution = await executeTool({
      name: "evidence.search",
      arguments: { reason: "跨行检索", windows: [{ callId: "call_kw", keyword: "NEEDLE" }] },
      dataDir, conversationId: "cv_01", lookup,
    });
    const parsed = JSON.parse(execution.text) as { ok: boolean; results: Record<string, unknown>[] };
    const row = parsed.results[0]! as Record<string, unknown>;
    expect(row.ok).toBe(true);
    expect(row.matchCount).toBe(1);
    const hit = (row.matches as { hit: string }[])[0]!.hit;
    expect(hit.replace(/[\r\n]+/g, "")).toBe("NEEDLE");
    expect((row.matches as { lineStart: number }[])[0]!.lineStart).toBeGreaterThan(0);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("evidence.search paddingLines expands upward and marks isTarget", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-evidence-pad-"));
  try {
    const width = runtimeConfig.results.lineWidth;
    const body = Array.from({ length: 30 }, (_, i) => String(i + 1).padStart(width, `${(i + 1) % 10}`)).join("");
    saveFullReturn(dataDir, "cv_01", "call_pad", body);
    const execution = await executeTool({
      name: "evidence.search",
      arguments: { reason: "向前回溯", windows: [{ callId: "call_pad", startLine: 10, paddingLines: 3 }] },
      dataDir, conversationId: "cv_01", lookup,
    });
    const parsed = JSON.parse(execution.text) as { ok: boolean; results: Record<string, unknown>[] };
    const row = parsed.results[0]! as Record<string, unknown>;
    expect(row).toMatchObject({ ok: true, mode: "lines", startLine: 7, targetLine: 10, paddingLines: 3 });
    const slice = row.lines as { line: number; isTarget: boolean }[];
    expect(slice[0]!.line).toBe(7);
    expect(slice.find((item) => item.line === 10)!.isTarget).toBe(true);
    expect(slice.find((item) => item.line === 7)!.isTarget).toBe(false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("evidence.search hybrid only matches keyword inside startLine window", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-evidence-hybrid-"));
  try {
    const width = runtimeConfig.results.lineWidth;
    const line1 = `keep ${"x".repeat(width - 5)}`; // no TARGET
    const line2 = `anchor ${"y".repeat(width - 7)}`.slice(0, width); // window start
    const line3 = `has TARGET_WORD inside ${"z".repeat(width)}`.slice(0, width);
    const body = [line1, line2, line3].join("\n");
    saveFullReturn(dataDir, "cv_01", "call_h", body);
    // Without anchor: would match
    const full = await executeTool({
      name: "evidence.search",
      arguments: { reason: "全文", windows: [{ callId: "call_h", keyword: "TARGET_WORD" }] },
      dataDir, conversationId: "cv_01", lookup,
    });
    expect(JSON.parse(full.text).results[0]).toMatchObject({ ok: true, matchCount: 1 });
    // Anchored at line 2, small context: line 3 may be out of a tiny window
    const anchored = await executeTool({
      name: "evidence.search",
      arguments: { reason: "锚点", windows: [{ callId: "call_h", keyword: "TARGET_WORD", startLine: 1, contextChars: 20 }] },
      dataDir, conversationId: "cv_01", lookup,
    });
    const row = JSON.parse(anchored.text).results[0];
    expect(row.mode).toBe("hybrid");
    expect(row.ok).toBe(false);
    expect(row.faultCode).toBe("not_found");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("evidence.search resolves a levelId chunk from the layered index tree", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-evidence-level-"));
  try {
    const callId = "call_lv";
    saveFullReturn(dataDir, "cv_01", callId, Array.from({ length: 400 }, (_, i) => `row ${i} payload`).join("\n"));
    const labels = Array.from({ length: 200 }, (_, i) => `mod.ts:${i + 1} "${"x".repeat(30)}"`);
    const tree = buildLevels("counts: matches×200", labels);
    saveReturnIndexTree(dataDir, "cv_01", callId, tree);
    const second = tree.levels[0]!.chunks[1]!;
    expect(second).toBeDefined();
    const execution = await executeTool({
      name: "evidence.search",
      arguments: { reason: "按块取回", windows: [{ callId, levelId: second.id }] },
      dataDir, conversationId: "cv_01", lookup,
    });
    const row = JSON.parse(execution.text).results[0] as Record<string, unknown>;
    expect(row.ok).toBe(true);
    expect(row.levelId).toBe(second.id);
    expect(row.levelName).toBe("L1明细");
    expect(row.content).toBe(second.text);
    expect(String(row.content).length).toBeLessThanOrEqual(runtimeConfig.results.inlineChars);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("evidence.search reports missing tree and unknown level ids", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-evidence-level-bad-"));
  try {
    saveFullReturn(dataDir, "cv_01", "call_a", "body");
    const missing = await executeTool({
      name: "evidence.search",
      arguments: { reason: "无树", windows: [{ callId: "call_a", levelId: "L1.1" }] },
      dataDir, conversationId: "cv_01", lookup,
    });
    expect(JSON.parse(missing.text).results[0]).toMatchObject({ ok: false, faultCode: "not_found" });
    const labels = Array.from({ length: 200 }, (_, i) => `mod.ts:${i + 1} "y"`);
    saveReturnIndexTree(dataDir, "cv_01", "call_b", buildLevels("counts: matches×200", labels));
    const unknown = await executeTool({
      name: "evidence.search",
      arguments: { reason: "未知块", windows: [{ callId: "call_b", levelId: "L9.9" }] },
      dataDir, conversationId: "cv_01", lookup,
    });
    expect(JSON.parse(unknown.text).results[0]).toMatchObject({ ok: false, faultCode: "not_found" });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
