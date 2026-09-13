import type { QueryEvidence } from "../context/projections/queries.ts";
import type { Memories, MemoryRecord } from "../memory/types.ts";
import type { GoalRecord, Ledger, PageObservation, ToolIOItem, Turn, TurnOutput, UserInputRecord } from "../types.ts";
import { inputRecord } from "./ids.ts";
import { loadTurn } from "./store.ts";

/** A turn's process, distinct from current memory and mutable working notes. */
export type TurnHistoryRecord = {
  conversationId: string;
  turnId: string;
  status: Turn["status"];
  createdAt: string;
  completedAt: string | null;
  userInput: UserInputRecord;
  goalChanges: GoalRecord[];
  toolIO: ToolIOItem[];
  pageObservations: PageObservation[];
  memoryWrites: MemoryRecord[];
  queryHistory: QueryEvidence[];
  output: TurnOutput | null;
};

/** Assemble from existing identities; no new IDs, truncation or state mutations. */
export function assembleTurnHistory(ledger: Ledger, turn: Turn, memories: Memories = {project: [], conversation: []}): TurnHistoryRecord {
  if (ledger.conversationId !== turn.conversationId || !ledger.turnIds.includes(turn.turnId)) {
    throw new Error("Turn does not belong to the conversation history");
  }
  return structuredClone({
    conversationId: turn.conversationId,
    turnId: turn.turnId,
    status: turn.status,
    createdAt: turn.createdAt,
    completedAt: turn.completedAt,
    userInput: inputRecord(turn),
    goalChanges: turn.goalChanges,
    toolIO: ledger.toolIO.filter(item => item.turnId === turn.turnId),
    pageObservations: turn.assembled.pageObservedHistory.filter(item => item.turnId === turn.turnId),
    memoryWrites: memories.conversation.filter(item => item.turnId === turn.turnId),
    queryHistory: ledger.queryHistory.filter(item => item.turnId === turn.turnId),
    output: turn.output,
  });
}

/** Only settled turns are candidates for whole-turn archival; active turns need batch segmentation. */
export function loadSettledTurnHistory(dataDir: string, ledger: Ledger, memories: Memories = {project: [], conversation: []}): TurnHistoryRecord[] {
  return ledger.turnIds.filter(id => id !== ledger.active?.turnId).flatMap(id => {
    const turn = loadTurn(dataDir, ledger.conversationId, id);
    if (!turn.completedAt || (turn.status !== "completed" && turn.status !== "failed" && turn.status !== "waiting_human")) return [];
    return [assembleTurnHistory(ledger, turn, memories)];
  });
}
