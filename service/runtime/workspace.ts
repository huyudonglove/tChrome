import { isDeepStrictEqual } from "node:util";
import type { Ledger, ToolIOItem, Turn, WorkspaceEntry } from "../types.ts";
import { extractWorkspaceEvidence, type WorkspaceEvidence } from "./workspace-extract.ts";
import { allocateRecordId } from "./ids.ts";
import { NEUTRAL_TOOLS } from "./escalation.ts";
import { loadTurn, saveTurn } from "./store.ts";
import { runtimeConfig } from "../config/runtime.ts";

export const formatBoundId = (seq: number): string => `b${String(seq).padStart(2, "0")}`;

/** Record the final admitted return; full originals remain in the existing return store. */
export function recordWorkspaceEvidence(dataDir: string, ledger: Ledger, turn: Turn, row: ToolIOItem): void {
  if (row.arguments.keepInCalls !== true || NEUTRAL_TOOLS.has(row.name)) return;
  for (const evidence of extractWorkspaceEvidence(row.name, row.arguments, row.return.text, row.callId)) {
    ledger.notes.push({ ...evidence,
      id: allocateRecordId(dataDir, ledger.conversationId, "workspace").replace("_", ""),
      turnId: turn.turnId, boundId: formatBoundId(ledger.boundSeq),
      callId: row.callId, callIds: [row.callId],
    });
  }
  if (ledger.notes.length >= runtimeConfig.context.notesFlushRows) flushWorkspaceNotes(dataDir, ledger, turn);
}

const empty = (value: unknown): boolean => value == null
  || (typeof value === "string" && value.trim() === "")
  || (Array.isArray(value) && value.length === 0)
  || (typeof value === "object" && Object.keys(value).length === 0);

/** Keep source rows intact; the workspace projection groups and deduplicates their evidence. */
export function flushWorkspaceNotes(dataDir: string, ledger: Ledger, currentTurn: Turn): void {
  const turns = new Map<string, Turn>([[currentTurn.turnId, currentTurn]]);
  for (const entry of ledger.notes) {
    // A failure, status, or successful mutation result is evidence even without content.
    if (empty(entry.result) && empty(entry.content)) continue;
    let turn = turns.get(entry.turnId);
    if (!turn) {
      turn = loadTurn(dataDir, ledger.conversationId, entry.turnId);
      turns.set(entry.turnId, turn);
    }
    turn.assembled.workspace.push(entry);
  }
  for (const turn of turns.values()) if (turn !== currentTurn) saveTurn(dataDir, turn);
  ledger.notes = [];
}

type Source = Pick<WorkspaceEntry, "id" | "turnId" | "callId" | "boundId">;
type Operation = WorkspaceEvidence & { sources: Source[]; revision: number };
export type WorkspaceGroup = { target: WorkspaceEvidence["target"]; operations: Operation[] };

/** Merge identical evidence only within an unchanged object's operation interval. */
export function groupWorkspaceEvidence(entries: WorkspaceEntry[]): WorkspaceGroup[] {
  const groups = new Map<string, WorkspaceGroup>();
  const revisions = new Map<string, number>();
  const browserPages = new Map<string, string>();
  for (const entry of entries) {
    const { id, turnId, callId, callIds: _, boundId, ...evidence } = entry;
    const key = JSON.stringify(entry.target);
    let group = groups.get(key);
    if (!group) { group = { target: entry.target, operations: [] }; groups.set(key, group); }
    const scope = entry.target.scope ? JSON.stringify([entry.target.kind, entry.target.scope]) : key;
    let revision = revisions.get(scope) ?? 0;
    const pageChanged = entry.target.kind === "browser" && entry.target.scope && entry.target.key !== entry.target.scope
      && browserPages.has(scope) && browserPages.get(scope) !== entry.target.key;
    if (entry.mutation || pageChanged) revision++;
    if (entry.target.kind === "browser" && entry.target.scope && entry.target.key !== entry.target.scope) browserPages.set(scope, entry.target.key);
    revisions.set(scope, revision);
    const source = { id, turnId, callId, boundId };
    const comparable = (value: WorkspaceEvidence) => {
      const { args, ...rest } = value;
      const { reason: _reason, keepInCalls: _keep, ...input } = args ?? {};
      return { ...rest, args: input };
    };
    const duplicate = !entry.mutation && group.operations.find(operation => {
      const { sources: _sources, revision: priorRevision, ...prior } = operation;
      return priorRevision === revision && isDeepStrictEqual(comparable(prior), comparable(evidence));
    });
    if (duplicate) duplicate.sources.push(source);
    else group.operations.push({ ...evidence, revision, sources: [source] });
  }
  return [...groups.values()];
}
