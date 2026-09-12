import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { allocateRecordId } from "./ids.ts";
import type { Ledger, Turn, Provider, ToolIOItem } from "../types.ts";
import type { Memories } from "../memory/types.ts";
import { archiveDir, loadIndex } from "../context-archive/store.ts";
import { compressRecords } from "../agents/compression/index.ts";
import type { SourceRecord } from "../context-archive/types.ts";
import type { QueryEvidence } from "../context/projections/queries.ts";
import { assembleTurnHistory, loadSettledTurnHistory, type TurnHistoryRecord } from "./turn-history.ts";

export const HISTORY_MODULE = "conversationHistory" as const;
const KEEP_TURNS = 3;
const KEEP_BATCHES = 2;
const querySourceKey = (queryId: string) => JSON.stringify(["query", queryId]);
const fullTurnKey = (turnId: string) => JSON.stringify(["turn", turnId]);
const batchKey = (row: ToolIOItem) => row.batchId ?? row.callId;
const batchSourceKey = (turnId: string, batch: string) => JSON.stringify(["batch", turnId, batch]);

/** Logical keys stay internal; only selected archive sources reserve a public ID. */
function sourceIdentities(dataDir: string, conversationId: string) {
  const dir = archiveDir(dataDir, conversationId, HISTORY_MODULE);
  const path = join(dir, "source-ids.json");
  let ids: Record<string, string> = {};
  try { ids = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return {
    covered: (key: string, covered: Set<string>) => ids[key] !== undefined && covered.has(ids[key]!),
    reserve: (key: string) => {
      if (ids[key]) return ids[key]!;
      const id = allocateRecordId(dataDir, conversationId, "source");
      ids[key] = id;
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(ids));
      renameSync(`${path}.tmp`, path);
      return id;
    },
  };
}

function sourceCoverage(ledger: Ledger, isCovered: (key: string) => boolean) {
  const turnCovered = (turnId: string) => isCovered(fullTurnKey(turnId));
  const toolCovered = (row: ToolIOItem) => turnCovered(row.turnId) || isCovered(batchSourceKey(row.turnId, batchKey(row)));
  // Include the turn in the key: provider call IDs can be reused across different turns.
  const callBatches = new Map(ledger.toolIO.map(row => [JSON.stringify([row.turnId, row.callId]), row]));
  const originCovered = (turnId: string, callId: string) => {
    if (turnCovered(turnId)) return true;
    const row = callBatches.get(JSON.stringify([turnId, callId]));
    return row ? toolCovered(row) : false;
  };
  return { turnCovered, toolCovered, originCovered };
}

/** Source coverage controls the view; complete local records and current state are never pruned. */
export function contextState(dataDir: string, ledger: Ledger, turn: Turn, memories: Memories) {
  const index = loadIndex(dataDir, ledger.conversationId, HISTORY_MODULE);
  const covered = new Set(index.coveredSourceIds);
  const identities = sourceIdentities(dataDir, ledger.conversationId);
  const isCovered = (key: string) => identities.covered(key, covered);
  const { turnCovered, toolCovered, originCovered } = sourceCoverage(ledger, isCovered);
  const byId = new Map(index.entries.map(entry => [entry.id, entry]));
  const turnOrder = new Map(ledger.turnIds.map((id, i) => [id, i]));
  const summaries = index.activeIds.map(id => {
    const entry = byId.get(id);
    if (!entry) throw new Error(`Missing active turn summary: ${id}`);
    return entry;
  }).sort((a, b) => (turnOrder.get(a.turnId) ?? Infinity) - (turnOrder.get(b.turnId) ?? Infinity));
  return {
    ledger: { ...ledger,
      userInputHistory: ledger.userInputHistory.filter(row => !turnCovered(row.turnId)),
      goalHistory: ledger.goalHistory.filter(row => !originCovered(row.turnId, row.sourceCallId)),
      toolIO: ledger.toolIO.filter(row => !toolCovered(row)),
      queryHistory: ledger.queryHistory.filter(row => !isCovered(querySourceKey(row.queryId))),
    },
    turn: { ...turn, assembled: { ...turn.assembled,
      pageObservedHistory: turn.assembled.pageObservedHistory.filter(row => !originCovered(row.turnId, row.callId)),
    } },
    memories: { ...memories, conversation: memories.conversation.filter(row => !originCovered(row.turnId, row.sourceCallId)) },
    summaries,
  };
}

type CompressionInput = { dataDir: string; repoRoot: string; provider: Provider; ledger: Ledger; turn: Turn; memories: Memories; isCancelled: () => boolean };

/** Called only inside the single 200K send-boundary flow, never at turn completion. */
export async function compressContext(input: CompressionInput, phase: "history" | "current" | "summaries" = "history") {
  if (input.isCancelled()) throw new Error("compression_cancelled");
  const { ledger, turn, memories, dataDir } = input;
  const index = loadIndex(dataDir, ledger.conversationId, HISTORY_MODULE);
  const covered = new Set(index.coveredSourceIds);
  const identities = sourceIdentities(dataDir, ledger.conversationId);
  const isCovered = (key: string) => identities.covered(key, covered);
  const coverage = sourceCoverage(ledger, isCovered);
  const records: SourceRecord[] = [];
  // Queries move to history later than their original tool batch. Give each an independent
  // immutable source so already-covered batches/turns cannot hide newly retired evidence.
  const addQuerySources = (history: TurnHistoryRecord, queries: QueryEvidence[]) => {
    const batches = [...new Set(history.toolIO.map(batchKey))];
    for (const query of queries) {
      const key = querySourceKey(query.queryId);
      if (isCovered(key)) continue;
      const id = identities.reserve(key);
      const tool = history.toolIO.find(row => row.callId === query.sourceCallId);
      records.push({ id, content: {
        conversationId: history.conversationId, turnId: history.turnId,
        status: history.status, createdAt: history.createdAt, completedAt: null,
        goalChanges: [], toolIO: [], pageObservations: [], memoryWrites: [],
        queryHistory: [query], output: null,
        sequence: { turn: ledger.turnIds.indexOf(history.turnId), batch: tool ? batches.indexOf(batchKey(tool)) : batches.length },
        segment: { complete: false },
      } });
    }
  };
  if (phase === "history") {
    const settled = loadSettledTurnHistory(dataDir, ledger, memories);
    for (const history of settled.slice(0, -KEEP_TURNS)) {
      addQuerySources(history, history.queryHistory);
      const key = fullTurnKey(history.turnId);
      if (isCovered(key)) continue;
      const id = identities.reserve(key);
      // If this turn was segmented while active, archive only its remaining modules plus final output.
      const projected = { ...history, queryHistory: [],
        goalChanges: history.goalChanges.filter(row => !coverage.originCovered(row.turnId, row.sourceCallId)),
        toolIO: history.toolIO.filter(row => !coverage.toolCovered(row)),
        pageObservations: history.pageObservations.filter(row => !coverage.originCovered(row.turnId, row.callId)),
        memoryWrites: history.memoryWrites.filter(row => !coverage.originCovered(row.turnId, row.sourceCallId)),
      };
      records.push({ id, content: { ...projected,
        sequence: { turn: ledger.turnIds.indexOf(history.turnId), batch: ledger.toolIO.filter(row => row.turnId === history.turnId).length },
        segment: { complete: true },
      } });
    }
  } else if (phase === "current") {
    const active = assembleTurnHistory(ledger, turn, memories);
    const batches = [...new Set(active.toolIO.map(batchKey))];
    const olderBatches = new Set(batches.slice(0, -KEEP_BATCHES));
    const olderCalls = new Set(active.toolIO.filter(row => olderBatches.has(batchKey(row))).map(row => row.callId));
    addQuerySources(active, active.queryHistory.filter(query => query.sourceCallId && olderCalls.has(query.sourceCallId)));
    for (const batch of olderBatches) {
      const key = batchSourceKey(turn.turnId, batch);
      if (isCovered(key)) continue;
      const id = identities.reserve(key);
      const tools = active.toolIO.filter(row => batchKey(row) === batch);
      const calls = new Set(tools.map(row => row.callId));
      records.push({ id, content: { ...active,
        completedAt: null, output: null, queryHistory: [],
        goalChanges: active.goalChanges.filter(row => calls.has(row.sourceCallId)),
        toolIO: tools,
        pageObservations: active.pageObservations.filter(row => calls.has(row.callId)),
        memoryWrites: active.memoryWrites.filter(row => calls.has(row.sourceCallId)),
        sequence: { turn: ledger.turnIds.indexOf(turn.turnId), batch: batches.indexOf(batch) },
        segment: { complete: false, batchIds: [batch] },
      } });
    }
  }
  await compressRecords({ ...input, conversationId: ledger.conversationId, module: HISTORY_MODULE, records, recompress: phase === "summaries" });
}
