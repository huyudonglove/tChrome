import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUMMARY_RECOMPRESS_MIN_ACTIVE, compressRecords } from "./index.ts";
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
    goalChanges: [],
    toolIO: [],
    pageObservations: [],
    memoryWrites: [],
    queryHistory: [],
    output: { kind: "reply", text: turnId },
    sequence: { turn: Number(turnId.slice(3)), batch: 0 },
    segment: { complete: true },
  },
});

test("turns that already have summaries skip re-compression until active list exceeds 30", async () => {
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

  // New sources for the same turn would merge/re-level — blocked while active ≤ 100.
  const outcome = await compressRecords({
    dataDir,
    conversationId,
    repoRoot,
    provider,
    module: "conversationHistory",
    records: [turnSource("src_02", "tn_01")],
  });
  const index = loadIndex(dataDir, conversationId, "conversationHistory");
  expect(index.activeIds).toEqual([firstSumId]);
  expect(index.entries.filter(e => e.turnId === "tn_01")).toHaveLength(1);
  expect(index.coveredSourceIds).not.toContain("src_02");
  expect(outcome.committedTurnIds).toEqual([]);

  // Pad active summaries to exceed the threshold, then re-compression is allowed.
  const padEntries = Array.from({ length: SUMMARY_RECOMPRESS_MIN_ACTIVE }, (_, i) => ({
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

  const together = await compressRecords({
    dataDir,
    conversationId,
    repoRoot,
    provider,
    module: "conversationHistory",
    records: [turnSource("src_02", "tn_01")],
  });
  const after = loadIndex(dataDir, conversationId, "conversationHistory");
  expect(together.committedTurnIds).toEqual(["tn_01"]);
  const tn01 = after.entries.filter(e => e.turnId === "tn_01");
  expect(tn01.some(e => e.level >= 2)).toBe(true);
  expect(after.activeIds).toContain(tn01.find(e => e.level >= 2)!.id);
  expect(after.activeIds).not.toContain(firstSumId);
  expect(after.coveredSourceIds).toContain("src_02");
});
