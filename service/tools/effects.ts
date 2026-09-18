import type { CurrentPage, GoalRecord, MemoryLayer } from "../types.ts";
import type { QueryEvidence } from "../context/projections/queries.ts";

// Tools describe domain changes; only the runtime applies and persists them.
export type ToolEffect =
  | { type: "query.set"; query: Omit<QueryEvidence, "queryId" | "turnId" | "sourceCallId"> }
  | { type: "goal.upsert"; record: GoalRecord; currentGoalId: string | null }
  | { type: "note.write"; key: string; value: string }
  | { type: "note.delete"; key: string }
  | { type: "memory.append"; entries: { layer: MemoryLayer; text: string }[] }
  | { type: "tools.enable"; names: string[] }
  | { type: "page.set"; page: CurrentPage; result: Record<string, unknown> }
  | { type: "page.clear_result"; pageId: string }
  | { type: "checklist.set"; title?: string; items: { text: string; status: "todo" | "doing" | "done" }[] }
  | { type: "checklist.update"; items: { index: number; status?: "todo" | "doing" | "done"; text?: string }[] }
  | { type: "tab.context.set"; tabId: number }
  | { type: "tab.context.clear" }
  | { type: "turn.ask"; question: string }
  | { type: "turn.reply"; text: string }
  | { type: "queue.clear" };

export type ToolExecution = { text: string; effects: ToolEffect[] };
