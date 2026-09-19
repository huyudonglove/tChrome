import { join } from "node:path";
import type { QueryEvidence } from "../context/projections/queries.ts";
import type { Memories, MemoryRecord } from "../memory/types.ts";
import type { GoalRecord, Ledger, PageObservation, ToolIOItem, Turn, TurnOutput, UserInputRecord } from "../types.ts";
import { compressedArchiveFields, loadModuleRegistry } from "../context/modules.ts";
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

type ProjectContext = { ledger: Ledger; turn: Turn; memories: Memories };

/** projectors keyed by inventory archiveField; assemble only what the inventory marks compress:true. */
const projectors: Record<string, (ctx: ProjectContext) => unknown> = {
  userInput: ({ turn }) => inputRecord(turn),
  goalChanges: ({ turn }) => turn.goalChanges,
  toolIO: ({ ledger, turn }) => ledger.toolIO.filter(item => item.turnId === turn.turnId),
  pageObservations: ({ turn }) => turn.assembled.pageObservedHistory.filter(item => item.turnId === turn.turnId),
  memoryWrites: ({ turn, memories }) => memories.conversation.filter(item => item.turnId === turn.turnId),
  queryHistory: ({ ledger, turn }) => ledger.queryHistory.filter(item => item.turnId === turn.turnId),
  output: ({ turn }) => {
    const out = turn.output;
    if (out && out.kind === "reply") return { kind: "reply", text: out.summary };
    return out;
  },
};

const defaultRepoRoot = () => join(import.meta.dir, "../..");

export function turnHistoryFromInventory(repoRoot: string, ctx: ProjectContext): TurnHistoryRecord {
  const { ledger, turn } = ctx;
  if (ledger.conversationId !== turn.conversationId || !ledger.turnIds.includes(turn.turnId)) {
    throw new Error("Turn does not belong to the conversation history");
  }
  const inventory = loadModuleRegistry(repoRoot);
  const base = {
    conversationId: turn.conversationId,
    turnId: turn.turnId,
    status: turn.status,
    createdAt: turn.createdAt,
    completedAt: turn.completedAt,
  } as Record<string, unknown>;
  for (const field of compressedArchiveFields(inventory)) {
    const project = projectors[field];
    if (!project) throw new Error(`missing compression projector: ${field}`);
    base[field] = project(ctx);
  }
  return structuredClone(base) as TurnHistoryRecord;
}

/** Assemble from existing identities; no new IDs, truncation or state mutations. */
export function assembleTurnHistory(ledger: Ledger, turn: Turn, memories: Memories = { project: [], conversation: [] }, repoRoot = defaultRepoRoot()): TurnHistoryRecord {
  return turnHistoryFromInventory(repoRoot, { ledger, turn, memories });
}

/** Only settled turns are candidates for whole-turn archival; active turns need batch segmentation. */
export function loadSettledTurnHistory(dataDir: string, ledger: Ledger, memories: Memories = { project: [], conversation: [] }, repoRoot = defaultRepoRoot()): TurnHistoryRecord[] {
  return ledger.turnIds.filter(id => id !== ledger.active?.turnId).flatMap(id => {
    const turn = loadTurn(dataDir, ledger.conversationId, id);
    if (!turn.completedAt || (turn.status !== "completed" && turn.status !== "failed" && turn.status !== "waiting_human")) return [];
    return [assembleTurnHistory(ledger, turn, memories, repoRoot)];
  });
}
