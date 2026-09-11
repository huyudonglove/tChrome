import { createHash } from "node:crypto";
import type { Ledger, Turn, Provider, ToolIOItem } from "../types.ts";
import type { Memories } from "../memory/types.ts";
import { loadIndex } from "../context-archive/store.ts";
import { compressRecords } from "../agents/compression/index.ts";
import type { SourceRecord } from "../context-archive/types.ts";
import { assembleTurnHistory, loadSettledTurnHistory } from "./turn-history.ts";

export const HISTORY_MODULE = "conversationHistory" as const;
const KEEP_TURNS = 3;
const KEEP_BATCHES = 2;
const fullTurnId = (turnId: string) => `turn_${turnId}`;
const batchKey = (row: ToolIOItem) => row.batchId ?? row.callId;
const batchSourceId = (turnId: string, batch: string) => `segment_${createHash("sha256").update(JSON.stringify([turnId, batch])).digest("hex")}`;

function sourceCoverage(ledger: Ledger, covered: Set<string>) {
  const turnCovered = (turnId: string) => covered.has(fullTurnId(turnId));
  const toolCovered = (row: ToolIOItem) => turnCovered(row.turnId) || covered.has(batchSourceId(row.turnId, batchKey(row)));
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
  const { turnCovered, toolCovered, originCovered } = sourceCoverage(ledger, new Set(index.coveredSourceIds));
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
  const coverage = sourceCoverage(ledger, covered);
  const records: SourceRecord[] = [];
  if (phase === "history") {
    const settled = loadSettledTurnHistory(dataDir, ledger, memories);
    for (const history of settled.slice(0, -KEEP_TURNS)) {
      const id = fullTurnId(history.turnId);
      if (covered.has(id)) continue;
      // If this turn was segmented while active, archive only its remaining modules plus final output.
      const projected = { ...history,
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
    for (const batch of batches.slice(0, -KEEP_BATCHES)) {
      const id = batchSourceId(turn.turnId, batch);
      if (covered.has(id)) continue;
      const tools = active.toolIO.filter(row => batchKey(row) === batch);
      const calls = new Set(tools.map(row => row.callId));
      records.push({ id, content: { ...active,
        completedAt: null, output: null,
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
