import { allocateRecordId } from "../../runtime/ids.ts";
import { runtimeConfig } from "../../config/runtime.ts";
import type { Provider } from "../../types.ts";
import { requestCrossTurnFold, requestTurnSummaries, type CompressionTurn } from "./protocol.ts";
import { commitArchive, loadIndex } from "../../context-archive/store.ts";
import type { CompressionModule, CompressionRecord, SourceRecord } from "../../context-archive/types.ts";

type Input = {
  dataDir: string; conversationId: string; repoRoot: string; provider: Provider;
  module: CompressionModule; records: SourceRecord[]; isCancelled?: () => boolean;
  onProgress?: (event: CompressProgress) => void;
};

export type CompressOutcome = {
  status: "completed" | "stopped" | "noop";
  committedTurnIds: string[];
  failedTurnId?: string;
  totalTurns: number;
};

export type CompressProgress =
  | { type: "start"; total: number }
  | { type: "turn"; completed: number; total: number; turnId: string }
  | { type: "fold"; merged: number; level: number; turnIds: number }
  | { type: "stopped"; completed: number; total: number; failedTurnId?: string };

const running = new Map<string, { isCancelled?: () => boolean }>();

/** Turns that already have active summaries merge only when the active list is longer than this. */
export const SUMMARY_RECOMPRESS_MIN_ACTIVE = runtimeConfig.context.summaryRecompressMinActive;

function asTurn(content: unknown): CompressionTurn {
  if (!content || typeof content !== "object" || !("turnId" in content) || typeof content.turnId !== "string" || !content.turnId.trim()) throw new Error("Compression source missing turnId");
  return content as CompressionTurn;
}

function turnOrder(sources: SourceRecord[]): number {
  const sequence = (sources[0]?.content as { sequence?: { turn?: number } } | null | undefined)?.sequence;
  return typeof sequence?.turn === "number" ? sequence.turn : Number.MAX_SAFE_INTEGER;
}

/**
 * Sequential compression walk.
 * Each turn is one request. Success archives that turn immediately and drops its originals
 * from the window via coveredSourceIds. The first failure stops the walk: that turn and all
 * later turns keep originals until a later compressAt trigger retries from uncovered turns.
 */
export async function compressRecords(input: Input): Promise<CompressOutcome> {
  const lock = JSON.stringify([input.dataDir, input.conversationId, input.module]);
  const previous = running.get(lock);
  if (previous && !previous.isCancelled?.()) throw new Error("Compression already running for this conversation");
  const owner = { isCancelled: input.isCancelled };
  running.set(lock, owner);
  try { return await compress(input); }
  finally { if (running.get(lock) === owner) running.delete(lock); }
}

async function compress(input: Input): Promise<CompressOutcome> {
  const check = () => { if (input.isCancelled?.()) throw new Error("Compression cancelled"); };
  check();
  const index = loadIndex(input.dataDir, input.conversationId, input.module);
  const covered = new Set(index.coveredSourceIds);
  const unique = new Map<string, SourceRecord>();
  for (const record of input.records) {
    if (covered.has(record.id)) continue;
    asTurn(record.content);
    const prior = unique.get(record.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(record)) throw new Error(`Conflicting source: ${record.id}`);
    unique.set(record.id, record);
  }
  const groups = new Map<string, SourceRecord[]>();
  for (const record of unique.values()) {
    const id = asTurn(record.content).turnId;
    groups.set(id, [...(groups.get(id) ?? []), record]);
  }
  const ordered = [...groups.entries()].sort((a, b) => turnOrder(a[1]) - turnOrder(b[1]));
  if (!ordered.length) return { status: "noop", committedTurnIds: [], totalTurns: 0 };

  const total = ordered.length;
  input.onProgress?.({ type: "start", total });
  const activeEntries = () => index.activeIds.map(id => index.entries.find(record => record.id === id)!);
  const committedTurnIds: string[] = [];
  const stop = (failedTurnId: string): CompressOutcome => {
    input.onProgress?.({ type: "stopped", completed: committedTurnIds.length, total, failedTurnId });
    return { status: "stopped", committedTurnIds, failedTurnId, totalTurns: total };
  };

  for (const [turnId, sources] of ordered) {
    check();
    // L1: always cover uncovered sources (a turn may accumulate several L1 rows).
    // L2: only when active summaries exceed the gate, fold prior summaries into a higher level.
    const priorSummaries = activeEntries().filter(record => record.turnId === turnId);
    const mergeAllowed = index.activeIds.length > SUMMARY_RECOMPRESS_MIN_ACTIVE;
    const mergeTurn = priorSummaries.length > 0 && mergeAllowed;
    const sourcesForTurn = sources;
    const priorForTurn = mergeTurn ? priorSummaries : [];
    if (!sourcesForTurn.length) continue;

    const turn: CompressionTurn = !priorForTurn.length && sourcesForTurn.length === 1
      ? asTurn(sourcesForTurn[0]!.content)
      : {
          turnId,
          segments: sourcesForTurn.map(source => asTurn(source.content)),
          summaries: priorForTurn.map(({ tag, userRequest, actions, result, reflection }) => ({ tag, userRequest, actions, result, ...(reflection ? { reflection } : {}) })),
        };

    let summaries;
    try {
      summaries = await requestTurnSummaries({
        provider: input.provider,
        repoRoot: input.repoRoot,
        turn,
        dataDir: input.dataDir,
        conversationId: input.conversationId,
        module: input.module,
      });
    } catch (error) {
      if (input.isCancelled?.() || (error instanceof Error && /cancel/i.test(error.message))) throw error;
      return stop(turnId);
    }
    check();

    // Same-turn consolidation stays L1; hierarchy levels only come from cross-turn folds.
    const level = 1;
    const sourceIds = [...priorForTurn.map(item => item.id), ...sourcesForTurn.map(source => source.id)];
    const createdAt = new Date().toISOString();
    const records: CompressionRecord[] = summaries.map((summary) => ({
      id: allocateRecordId(input.dataDir, input.conversationId, "sum"),
      module: input.module,
      level,
      ...summary,
      sourceIds: [...sourceIds],
      createdAt,
    }));
    for (const record of records) index.entries.push(record);
    if (priorForTurn.length) {
      const replaced = new Set(priorForTurn.map(item => item.id));
      const nextIds = records.map(record => record.id);
      index.activeIds = [...new Set(index.activeIds.flatMap(id => (replaced.has(id) ? nextIds : [id])))];
    } else index.activeIds.push(...records.map(record => record.id));
    sourcesForTurn.forEach(source => covered.add(source.id));
    index.coveredSourceIds = [...covered];
    commitArchive(input.dataDir, input.conversationId, index, sourcesForTurn, records);
    committedTurnIds.push(turnId);
    input.onProgress?.({ type: "turn", completed: committedTurnIds.length, total, turnId });
  }

  // Cross-turn fold is best-effort: a fold failure must not fail the turn walk.
  try {
    await foldActiveSummaries({ ...input, protectTurnId: committedTurnIds.at(-1) ?? null });
  } catch (error) {
    if (input.isCancelled?.() || (error instanceof Error && /cancel/i.test(error.message))) throw error;
  }

  return { status: committedTurnIds.length ? "completed" : "noop", committedTurnIds, totalTurns: total };
}

/** Chunk sizes keep each fold model call bounded. */
const FOLD_L1_TO_L2_CHUNK = 10;
const FOLD_L2_TO_L3_CHUNK = 8;

/**
 * Cross-turn summary folding per the confirmed rule:
 * - gate: active summaries above SUMMARY_RECOMPRESS_MIN_ACTIVE
 * - protect the newest turn's rows (current turn stays fresh)
 * - same-turn L1 groups fold into one L1; older L1s fold into L2 chunks
 *   (newest L1 kept); older L2s fold into L3 chunks (newest L2 kept)
 * - every fold is one model call; failures stop folding, never the walk
 */
export async function foldActiveSummaries(input: Input & { protectTurnId: string | null }): Promise<number> {
  const index = loadIndex(input.dataDir, input.conversationId, input.module);
  if (index.activeIds.length <= SUMMARY_RECOMPRESS_MIN_ACTIVE) return 0;
  const entries = () => index.activeIds
    .map((id) => index.entries.find((record) => record.id === id)!)
    .filter((record): record is CompressionRecord => Boolean(record));
  const byCreatedAt = (a: CompressionRecord, b: CompressionRecord) => a.createdAt.localeCompare(b.createdAt);
  const effectiveLevel = (record: CompressionRecord) => (record.level >= 2 ? 2 : 1);
  let merged = 0;
  const freshRecords: CompressionRecord[] = [];

  const foldRows = async (rows: CompressionRecord[], level: number): Promise<void> => {
    const turnIds = [...new Set(rows.map((row) => row.turnId))];
    const summary = await requestCrossTurnFold({
      provider: input.provider,
      repoRoot: input.repoRoot,
      level,
      turnIds,
      rows: rows.map((row) => ({
        turnId: row.turnId, tag: row.tag, userRequest: row.userRequest,
        actions: row.actions, result: row.result, ...(row.reflection ? { reflection: row.reflection } : {}),
      })),
      dataDir: input.dataDir,
      conversationId: input.conversationId,
      module: input.module,
    });
    const record: CompressionRecord = {
      id: allocateRecordId(input.dataDir, input.conversationId, "sum"),
      module: input.module,
      level,
      turnId: summary.turnId,
      turnIds,
      tag: summary.tag,
      userRequest: summary.userRequest,
      actions: summary.actions,
      result: summary.result,
      ...(summary.reflection ? { reflection: summary.reflection } : {}),
      sourceIds: rows.map((row) => row.id),
      createdAt: new Date().toISOString(),
    };
    index.entries.push(record);
    freshRecords.push(record);
    const replaced = new Set(rows.map((row) => row.id));
    index.activeIds = [...new Set(index.activeIds.flatMap((id) => (replaced.has(id) ? [record.id] : [id])))];
    merged += 1;
    input.onProgress?.({ type: "fold", merged, level, turnIds: turnIds.length });
  };

  // Phase A: same-turn L1 groups fold into one L1 row each.
  const byTurn = new Map<string, CompressionRecord[]>();
  for (const row of entries()) {
    if (row.turnId === input.protectTurnId) continue;
    if (effectiveLevel(row) !== 1) continue;
    byTurn.set(row.turnId, [...(byTurn.get(row.turnId) ?? []), row]);
  }
  for (const rows of byTurn.values()) {
    if (rows.length < 2) continue;
    input.isCancelled?.() && (() => { throw new Error("Compression cancelled"); })();
    await foldRows([...rows].sort(byCreatedAt), 1);
  }

  // Phase B: cross-turn L1 → L2, keep the newest L1.
  const l1Rest = entries()
    .filter((row) => effectiveLevel(row) === 1 && row.turnId !== input.protectTurnId)
    .sort(byCreatedAt);
  if (l1Rest.length > 1) {
    const foldable = l1Rest.slice(0, -1);
    for (let i = 0; i < foldable.length; i += FOLD_L1_TO_L2_CHUNK) {
      input.isCancelled?.() && (() => { throw new Error("Compression cancelled"); })();
      await foldRows(foldable.slice(i, i + FOLD_L1_TO_L2_CHUNK), 2);
    }
  }

  // Phase C: L2 → L3, keep the newest L2.
  const l2Rest = entries()
    .filter((row) => effectiveLevel(row) === 2 && row.turnId !== input.protectTurnId)
    .sort(byCreatedAt);
  if (l2Rest.length > 1) {
    const foldable = l2Rest.slice(0, -1);
    for (let i = 0; i < foldable.length; i += FOLD_L2_TO_L3_CHUNK) {
      input.isCancelled?.() && (() => { throw new Error("Compression cancelled"); })();
      await foldRows(foldable.slice(i, i + FOLD_L2_TO_L3_CHUNK), 3);
    }
  }

  if (freshRecords.length) commitArchive(input.dataDir, input.conversationId, index, [], freshRecords);
  return merged;
}
