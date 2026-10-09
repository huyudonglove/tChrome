import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldActiveSummaries } from "./index.ts";
import { runtimeConfig } from "../../config/runtime.ts";
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
    toolCalls: [{ id: "s", name: "submitLoopSummaries", arguments: { summary: "两轮合并纪要。", actions: "A", result: "R" } }],
    attempts: 1,
    parseOk: true,
    schemaOk: true,
    faultCode: null,
    missing: [],
  }),
};

const l1 = (id: string, loopId: string, minute: number): CompressionRecord => ({
  id,
  module: "conversationHistory",
  level: 1,
  loopIds: [loopId],
  summary: `第 ${loopId} 轮汇总。`,
  userRequest: `req-${loopId}`,
  actions: `act-${loopId}`,
  result: `res-${loopId}`,
  sourceIds: [],
  createdAt: `2026-09-20T00:${String(minute).padStart(2, "0")}:00.000Z`,
});

test("cross-loop fold keeps the newest loop and rolls older L1s into L2 spans", async () => {
  const dataDir = dir();
  const conversationId = "cv_fold";
  const pad = runtimeConfig.context.summaryFoldMinRows + 5;
  const rows: CompressionRecord[] = [];
  for (let i = 1; i <= pad; i++) rows.push(l1(`sum_pad_${i}`, `loop_${String(i).padStart(2, "0")}`, i));
  const protect = l1("sum_live", "loop_live", 99);
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
    module: "conversationHistory", records: [], protectLoopId: "loop_live",
  });

  expect(merged).toBeGreaterThan(0);
  const after = loadIndex(dataDir, conversationId, "conversationHistory");
  const active = after.activeIds.map((id) => after.entries.find((e) => e.id === id)!);
  // Protected turn stays intact and active.
  expect(active.some((e) => e.id === "sum_live")).toBe(true);
  // Newest remaining L1 is kept; older L1s folded into L2 spans.
  const l2 = active.filter((e) => e.level === 2);
  expect(l2.length).toBeGreaterThan(0);
  expect(l2.every((e) => (e.loopIds?.length ?? 0) > 1)).toBe(true);
  expect(l2.every((e) => e.summary === "两轮合并纪要。")).toBe(true);
  // Active count shrank: most pads are gone from the active list.
  expect(active.length).toBeLessThan(rows.length);
  expect(active.filter((e) => e.level === 1 && e.id !== "sum_live").length).toBeLessThanOrEqual(1);
});

test("fold is a no-op while a level stays at or below the per-level gate", async () => {
  const dataDir = dir();
  const conversationId = "cv_small";
  const gate = runtimeConfig.context.summaryFoldMinRows;
  // Exactly gate rows: "more than" the gate is required, so nothing upgrades.
  const rows: CompressionRecord[] = [];
  for (let i = 1; i <= gate; i++) rows.push(l1(`sum_a_${i}`, `loop_${String(i).padStart(2, "0")}`, i));
  const index = { version: 1 as const, module: "conversationHistory" as const, entries: rows, activeIds: rows.map((r) => r.id), coveredSourceIds: [] };
  commitArchive(dataDir, conversationId, index, [], rows);
  const merged = await foldActiveSummaries({
    dataDir, conversationId, repoRoot, provider,
    module: "conversationHistory", records: [], protectLoopId: null,
  });
  expect(merged).toBe(0);
  const after = loadIndex(dataDir, conversationId, "conversationHistory");
  expect(after.activeIds).toHaveLength(gate);
  expect(after.entries.every((e) => e.level === 1)).toBe(true);
});

test("fold upgrades a level once it exceeds the per-level gate", async () => {
  const dataDir = dir();
  const conversationId = "cv_over_gate";
  const gate = runtimeConfig.context.summaryFoldMinRows;
  const rows: CompressionRecord[] = [];
  for (let i = 1; i <= gate + 1; i++) rows.push(l1(`sum_b_${i}`, `loop_${String(i).padStart(2, "0")}`, i));
  commitArchive(dataDir, conversationId, {
    version: 1 as const, module: "conversationHistory" as const,
    entries: rows, activeIds: rows.map((r) => r.id), coveredSourceIds: [],
  }, [], rows);

  const merged = await foldActiveSummaries({
    dataDir, conversationId, repoRoot, provider,
    module: "conversationHistory", records: [], protectLoopId: null,
  });
  expect(merged).toBeGreaterThan(0);
  const after = loadIndex(dataDir, conversationId, "conversationHistory");
  expect(after.entries.some((e) => e.level === 2)).toBe(true);
  expect(after.activeIds.length).toBeLessThan(gate + 1);
});

test("same-loop L1+L1 stays L1; cross-loop L1 becomes L2", async () => {
  const dataDir = dir();
  const conversationId = "cv_rules";
  const pad = runtimeConfig.context.summaryFoldMinRows + 5;
  const rows: CompressionRecord[] = [];
  for (let i = 1; i <= pad; i++) rows.push(l1(`sum_pad_${i}`, `loop_${String(i).padStart(2, "0")}`, i));
  // Two extra L1s on one turn: same-ID merge must stay L1.
  rows.push(l1("sum_same_a", "loop_same", 50));
  rows.push(l1("sum_same_b", "loop_same", 51));
  rows.push(l1("sum_live", "loop_live", 99));
  commitArchive(dataDir, conversationId, {
    version: 1 as const, module: "conversationHistory" as const,
    entries: rows, activeIds: rows.map((r) => r.id), coveredSourceIds: [],
  }, [], rows);

  await foldActiveSummaries({
    dataDir, conversationId, repoRoot, provider,
    module: "conversationHistory", records: [], protectLoopId: "loop_live",
  });

  const after = loadIndex(dataDir, conversationId, "conversationHistory");
  const active = after.activeIds.map((id) => after.entries.find((e) => e.id === id)!);
  // Under the per-level gate this scenario only produces a handful of L2 rows,
  // so nothing upgrades further; L2 -> L3 has its own case below.
  expect(active.every((e) => e.level <= 2)).toBe(true);
  expect(after.entries.every((e) => e.level <= 2)).toBe(true);
  const l2 = active.filter((e) => e.level === 2);
  expect(l2.length).toBeGreaterThan(0);
  expect(l2.every((e) => (e.loopIds?.length ?? 0) > 1)).toBe(true);
  const sameLoop = active.filter((e) => e.loopIds?.includes("loop_same"));
  expect(sameLoop.every((e) => e.level === 1)).toBe(true);
});

test("L2 is not terminal: enough L2 rows upgrade one of them to L3", async () => {
  const dataDir = dir();
  const conversationId = "cv_l3";
  const gate = runtimeConfig.context.summaryFoldMinRows;
  const rows: CompressionRecord[] = [];
  for (let i = 1; i <= gate + 1; i++) {
    rows.push({
      ...l1(`sum_l2_${i}`, `loop_${String(i).padStart(2, "0")}`, i),
      level: 2,
      loopIds: [`loop_${String(i).padStart(2, "0")}_a`, `loop_${String(i).padStart(2, "0")}_b`],
    });
  }
  commitArchive(dataDir, conversationId, {
    version: 1 as const, module: "conversationHistory" as const,
    entries: rows, activeIds: rows.map((r) => r.id), coveredSourceIds: [],
  }, [], rows);

  const merged = await foldActiveSummaries({
    dataDir, conversationId, repoRoot, provider,
    module: "conversationHistory", records: [], protectLoopId: null,
  });
  expect(merged).toBeGreaterThan(0);
  const after = loadIndex(dataDir, conversationId, "conversationHistory");
  expect(after.entries.some((e) => e.level === 3)).toBe(true);
  expect(after.entries.every((e) => e.level <= 3)).toBe(true);
});

test("multiple L1 summaries spanning the same batch advance to L2 when folded", async () => {
  const dataDir = dir(), conversationId = "cv_batch_fold";
  const rows = Array.from({ length: runtimeConfig.context.summaryFoldMinRows + 1 }, (_, i) => ({
    ...l1(`sum_${i + 1}`, "loop_01", i), loopIds: ["loop_01", "loop_02"],
  }));
  commitArchive(dataDir, conversationId, { version: 1, module: "conversationHistory", entries: rows,
    activeIds: rows.map(row => row.id), coveredSourceIds: [] }, [], rows);
  await foldActiveSummaries({ dataDir, conversationId, repoRoot, provider, module: "conversationHistory", records: [], protectLoopId: null });
  const added = loadIndex(dataDir, conversationId, "conversationHistory").entries.slice(rows.length);
  expect(added.length).toBeGreaterThan(0);
  expect(added.every(row => row.level === 2 && row.loopIds.join(",") === "loop_01,loop_02")).toBe(true);
});
