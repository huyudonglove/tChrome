import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "./execute.ts";
import { applyToolEffects } from "../runtime/effects.ts";
import { emptyLedger, loadTurn, saveFullReturn } from "../runtime/store.ts";
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
    expect((row.matches as { before: string }[])[0]!.before.length).toBe(runtimeConfig.results.searchContextChars);
    expect((row.matches as { after: string }[])[0]!.after.length).toBe(runtimeConfig.results.searchContextChars);
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

test("evidence.search rejects keyword with startLine and blank modes", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-evidence-mode-"));
  try {
    saveFullReturn(dataDir, "cv_01", "call_01", "hello world");
    const both = await executeTool({
      name: "evidence.search",
      arguments: { reason: "x", windows: [{ callId: "call_01", keyword: "hello", startLine: 1 }] },
      dataDir, conversationId: "cv_01", lookup,
    });
    expect(JSON.parse(both.text)).toMatchObject({ ok: false, results: [{ ok: false, faultCode: "invalid_arguments" }] });
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
    saveContextRecord(dataDir, "cv_01", "pageObservation", {
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
    expect(row.path).toContain("context-records/pageObservation/page_01.json");
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

test("oversized page.set result is externalized with path and totalLines; full archive remains", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-ext-page-"));
  try {
    const ledger = emptyLedger("cv_ext");
    ledger.status = "running";
    ledger.active = { turnId: "tn_01" };
    const turn: Turn = {
      turnId: "tn_01", conversationId: "cv_ext", status: "inferring",
      createdAt: new Date().toISOString(), completedAt: null,
      input: { id: "input_01", text: "大结果", submittedAt: "now" },
      output: null, goalChanges: [],
      assembled: {
        baseToolsIds: [], toolIds: [],
        conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [],
        currentPage: null, openTabs: { ok: true, windows: [] }, pageObservedHistory: [],
      },
    };
    const bigResult = { ok: true, tabId: 7, url: "https://example.com", title: "T", blob: "b".repeat(runtimeConfig.results.inlineChars + 50) };
    applyToolEffects({
      dataDir, ledger, turn,
      call: { callId: "call_big", name: "page.list_interactive_elements", batchId: "batch_01", arguments: {} },
      effects: [{
        type: "page.set",
        page: { tabId: 7, url: "https://example.com", title: "T", description: "d" },
        result: bigResult,
      }],
    });
    const windowRow = turn.assembled.pageObservedHistory[0]!;
    expect(windowRow.result).toMatchObject({ ok: true, externalized: true, type: "page.list_interactive_elements" });
    const stub = windowRow.result as any;
    expect(stub.message).toContain("evidence.search");
    expect(stub.path).toContain("pageObservation");
    expect(stub.lineWidth).toBe(runtimeConfig.results.lineWidth);
    expect(stub.totalLines).toBe(Math.ceil(stub.totalChars / runtimeConfig.results.lineWidth));
    expect(stub.preview.length).toBe(runtimeConfig.results.previewChars);
    expect(stub.preview.startsWith('{"ok":true')).toBe(true);
    const archived = JSON.parse(loadContextRecord(dataDir, "cv_ext", "pageObservation", windowRow.id)!);
    expect(archived.result.blob.length).toBe(runtimeConfig.results.inlineChars + 50);
    const textPath = join(dataDir, "conversations", "cv_ext", "context-records", "pageObservation", `${windowRow.id}.txt`);
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
