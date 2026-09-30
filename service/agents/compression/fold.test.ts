import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUMMARY_RECOMPRESS_MIN_ACTIVE, foldActiveSummaries } from "./index.ts";
import { commitArchive, loadIndex } from "../../context-archive/store.ts";
import type { CompressionRecord } from "../../context-archive/types.ts";
import type { Provider } from "../../types.ts";

const repoRoot = join(import.meta.dir, "../../..");
const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "tchrome-fold-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const provider: Provider = {
  complete: async () => ({
    finish: "tool_calls",
    content: "",
    toolCalls: [{ id: "s", name: "submitTurnSummaries", arguments: { tag: "合并纪要", actions: "A", result: "R" } }],
    attempts: 1,
    parseOk: true,
    schemaOk: true,
    faultCode: null,
    missing: [],
  }),
};

const l1 = (id: string, turnId: string, minute: number): CompressionRecord => ({
  id,
  module: "conversationHistory",
  level: 1,
  turnId,
  tag: `tag-${turnId}`,
  userRequest: `req-${turnId}`,
  actions: `act-${turnId}`,
  result: `res-${turnId}`,
  sourceIds: [],
  createdAt: `2026-09-20T00:${String(minute).padStart(2, "0")}:00.000Z`,
});

test("cross-turn fold keeps the newest turn and rolls older L1s into L2 spans", async () => {
  const dataDir = dir();
  const conversationId = "cv_fold";
  const pad = SUMMARY_RECOMPRESS_MIN_ACTIVE + 5;
  const rows: CompressionRecord[] = [];
  for (let i = 1; i <= pad; i++) rows.push(l1(`sum_pad_${i}`, `tn_${String(i).padStart(2, "0")}`, i));
  const protect = l1("sum_live", "tn_live", 99);
  rows.push(protect);
  const index = {
    version: 1 as const,
    module: "conversationHistory" as const,
    entries: rows,
    activeIds: rows.map((r) => r.id),
    coveredSourceIds: [],
  };
  commitArchive(dataDir, conversationId, index, [], rows);

  const merged = await foldActiveSummaries({
    dataDir, conversationId, repoRoot, provider,
    module: "conversationHistory", records: [], protectTurnId: "tn_live",
  });

  expect(merged).toBeGreaterThan(0);
  const after = loadIndex(dataDir, conversationId, "conversationHistory");
  const active = after.activeIds.map((id) => after.entries.find((e) => e.id === id)!);
  // Protected turn stays intact and active.
  expect(active.some((e) => e.id === "sum_live")).toBe(true);
  // Newest remaining L1 is kept; older L1s folded into L2 spans.
  const l2 = active.filter((e) => e.level === 2);
  expect(l2.length).toBeGreaterThan(0);
  expect(l2.every((e) => (e.turnIds?.length ?? 0) > 1)).toBe(true);
  expect(l2.every((e) => e.tag === "合并纪要")).toBe(true);
  // Active count shrank: most pads are gone from the active list.
  expect(active.length).toBeLessThan(rows.length);
  expect(active.filter((e) => e.level === 1 && e.id !== "sum_live").length).toBeLessThanOrEqual(1);
});

test("fold is a no-op below the active-summary gate", async () => {
  const dataDir = dir();
  const conversationId = "cv_small";
  const rows = [l1("sum_a", "tn_01", 1), l1("sum_b", "tn_02", 2), l1("sum_live", "tn_live", 3)];
  const index = { version: 1 as const, module: "conversationHistory" as const, entries: rows, activeIds: rows.map((r) => r.id), coveredSourceIds: [] };
  commitArchive(dataDir, conversationId, index, [], rows);
  const merged = await foldActiveSummaries({
    dataDir, conversationId, repoRoot, provider,
    module: "conversationHistory", records: [], protectTurnId: "tn_live",
  });
  expect(merged).toBe(0);
  expect(loadIndex(dataDir, conversationId, "conversationHistory").activeIds).toHaveLength(3);
});

test("L1+L1 only: same turnId stays L1, different turnIds become L2, never L3", async () => {
  const dataDir = dir();
  const conversationId = "cv_rules";
  const pad = SUMMARY_RECOMPRESS_MIN_ACTIVE + 5;
  const rows: CompressionRecord[] = [];
  for (let i = 1; i <= pad; i++) rows.push(l1(`sum_pad_${i}`, `tn_${String(i).padStart(2, "0")}`, i));
  // Two extra L1s on one turn: same-ID merge must stay L1.
  rows.push(l1("sum_same_a", "tn_same", 50));
  rows.push(l1("sum_same_b", "tn_same", 51));
  rows.push(l1("sum_live", "tn_live", 99));
  commitArchive(dataDir, conversationId, {
    version: 1 as const, module: "conversationHistory" as const,
    entries: rows, activeIds: rows.map((r) => r.id), coveredSourceIds: [],
  }, [], rows);

  await foldActiveSummaries({
    dataDir, conversationId, repoRoot, provider,
    module: "conversationHistory", records: [], protectTurnId: "tn_live",
  });

  const after = loadIndex(dataDir, conversationId, "conversationHistory");
  const active = after.activeIds.map((id) => after.entries.find((e) => e.id === id)!);
  expect(active.every((e) => e.level <= 2)).toBe(true);
  expect(after.entries.every((e) => e.level <= 2)).toBe(true);
  const l2 = active.filter((e) => e.level === 2);
  expect(l2.every((e) => (e.turnIds?.length ?? 0) > 1)).toBe(true);
  const sameTurn = active.filter((e) => e.turnIds?.includes("tn_same") || e.turnId === "tn_same");
  expect(sameTurn.every((e) => e.level === 1)).toBe(true);
});
