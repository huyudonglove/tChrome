import { allocateRecordId } from "../../runtime/ids.ts";
import { runtimeConfig } from "../../config/runtime.ts";
import type { Provider } from "../../types.ts";
import { requestTurnSummaries, type CompressionTurn } from "./protocol.ts";
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

function isQueryOnlySource(source: SourceRecord): boolean {
  const c = source.content as Record<string, unknown> | null;
  if (!c || typeof c !== "object") return false;
  if (!Array.isArray(c.queryHistory) || !c.queryHistory.length) return false;
  for (const key of ["toolIO", "pageObservations", "memoryWrites", "goalChanges"] as const) {
    const list = c[key];
    if (Array.isArray(list) && list.length) return false;
  }
  return c.output == null;
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
    const priorSummaries = activeEntries().filter(record => record.turnId === turnId);
    const mergeAllowed = index.activeIds.length > SUMMARY_RECOMPRESS_MIN_ACTIVE;
    const mergeTurn = priorSummaries.length > 0 && mergeAllowed;
    const sourcesForTurn = priorSummaries.length > 0 && !mergeAllowed
      ? sources.filter(isQueryOnlySource)
      : sources;
    const priorForTurn = mergeTurn ? priorSummaries : [];
    if (!sourcesForTurn.length) continue;

    const turn: CompressionTurn = !priorForTurn.length && sourcesForTurn.length === 1
      ? asTurn(sourcesForTurn[0]!.content)
      : {
          turnId,
          segments: sourcesForTurn.map(source => asTurn(source.content)),
          summaries: priorForTurn.map(({ tag, userRequest, actions, result }) => ({ tag, userRequest, actions, result })),
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

    const level = priorForTurn.length ? Math.max(...priorForTurn.map(item => item.level)) + 1 : 1;
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

  return { status: committedTurnIds.length ? "completed" : "noop", committedTurnIds, totalTurns: total };
}
