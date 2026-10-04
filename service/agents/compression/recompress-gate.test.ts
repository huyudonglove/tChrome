import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUMMARY_RECOMPRESS_MIN_ACTIVE, compressRecords } from "./index.ts";
import { runtimeConfig } from "../../config/runtime.ts";
import { commitArchive, loadIndex } from "../../context-archive/store.ts";
import type { Provider } from "../../types.ts";

const repoRoot = join(import.meta.dir, "../../..");
const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "tchrome-recompress-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const provider: Provider = {
  complete: async () => ({
    finish: "tool_calls",
    content: "",
    toolCalls: [{ id: "s", name: "submitTurnSummaries", arguments: { tag: "T", actions: "A", result: "R" } }],
    attempts: 1,
    parseOk: true,
    schemaOk: true,
    faultCode: null,
    missing: [],
  }),
};

const turnSource = (id: string, turnId: string) => ({
  id,
  content: {
    conversationId: "cv_01",
    turnId,
    status: "completed",
    createdAt: "2026-09-20",
    completedAt: "2026-09-20",
    userInput: { id: `input_${turnId}`, turnId, userInput: turnId, submittedAt: "2026-09-20" },
        toolIO: [],
    observations: [], workspace: [],
    memoryWrites: [],
    queryHistory: [],
    stopReason: { kind: "reply", text: turnId },
    sequence: { turn: Number(turnId.slice(3)), batch: 0 },
    segment: { complete: true },
  },
});

test("extra sources take L1 immediately; L2 merge waits for the active L1 gate", async () => {
  const dataDir = dir();
  const conversationId = "cv_01";
  // Seed one L1 summary for tn_01 via a prior successful compress.
  await compressRecords({
    dataDir,
    conversationId,
    repoRoot,
    provider,
    module: "conversationHistory",
    records: [turnSource("src_01", "tn_01")],
  });
  const afterFirst = loadIndex(dataDir, conversationId, "conversationHistory");
  expect(afterFirst.activeIds).toHaveLength(1);
  const firstSumId = afterFirst.activeIds[0]!;
  const firstLevel = afterFirst.entries.find(e => e.id === firstSumId)!.level;
  expect(firstLevel).toBe(1);

  // Uncovered sources get extra L1 immediately (no merge yet).
  const outcome = await compressRecords({
    dataDir,
    conversationId,
    repoRoot,
    provider,
    module: "conversationHistory",
    records: [turnSource("src_02", "tn_01")],
  });
  const index = loadIndex(dataDir, conversationId, "conversationHistory");
  expect(outcome.committedTurnIds).toEqual(["tn_01"]);
  expect(index.entries.filter(e => e.turnId === "tn_01")).toHaveLength(2);
  expect(index.entries.filter(e => e.turnId === "tn_01").every(e => e.level === 1)).toBe(true);
  expect(index.coveredSourceIds).toContain("src_02");

  // Pad past both gates the merge has to clear: the recompress gate counts active L1
  // rows, and the cross-turn fold only runs once L1 rows exceed the per-level fold
  // minimum. Padding to the fold minimum alone would leave Phase B silent.
  const padLength = Math.max(SUMMARY_RECOMPRESS_MIN_ACTIVE + 1, runtimeConfig.context.summaryFoldMinRows + 1);
  const padEntries = Array.from({ length: padLength }, (_, i) => ({
    id: `sum_pad_${String(i + 1).padStart(2, "0")}`,
    module: "conversationHistory" as const,
    level: 1,
    tag: `p${i}`,
    turnId: `tn_${String(i + 2).padStart(2, "0")}`,
    userRequest: "u",
    actions: "a",
    result: "r",
    sourceIds: [] as string[],
    createdAt: "2026-09-20",
  }));
  index.entries.push(...padEntries);
  index.activeIds = [...index.activeIds, ...padEntries.map(e => e.id)];
  commitArchive(dataDir, conversationId, index, [], padEntries);

  // L2: a further uncovered source folds prior L1 rows into one higher-level summary.
  const together = await compressRecords({
    dataDir,
    conversationId,
    repoRoot,
    provider,
    module: "conversationHistory",
    records: [turnSource("src_03", "tn_01")],
  });
  const after = loadIndex(dataDir, conversationId, "conversationHistory");
  expect(together.committedTurnIds).toEqual(["tn_01"]);
  const tn01 = after.entries.filter(e => e.turnId === "tn_01");
  // Same-turn consolidation stays L1 under the new hierarchy semantics.
  expect(tn01.every(e => e.level === 1)).toBe(true);
  expect(tn01.some(e => e.id !== firstSumId)).toBe(true);
  expect(after.activeIds).not.toContain(firstSumId);
  expect(after.coveredSourceIds).toContain("src_03");
  // Cross-turn fold ran (active was above the gate): padded L1s became L2 spans.
  expect(after.entries.some(e => e.level === 2 && (e.turnIds?.length ?? 0) > 1)).toBe(true);
});
