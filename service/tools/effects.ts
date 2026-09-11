import type { CurrentPage, MemoryLayer } from "../types.ts";
import type { QueryEvidence } from "../context/projections/queries.ts";

// Tools describe domain changes; only the runtime applies and persists them.
export type ToolEffect =
  | { type: "query.set"; query: Omit<QueryEvidence, "queryId" | "turnId" | "sourceCallId"> }
  | { type: "goal.set"; goal: string }
  | { type: "note.write"; key: string; value: string }
  | { type: "note.delete"; key: string }
  | { type: "memory.append"; entries: { layer: MemoryLayer; text: string }[] }
  | { type: "tools.enable"; names: string[] }
  | { type: "page.set"; page: CurrentPage }
  | { type: "turn.ask"; question: string }
  | { type: "turn.reply"; text: string }
  | { type: "queue.clear" };

export type ToolExecution = { text: string; effects: ToolEffect[] };
