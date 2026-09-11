import type { CurrentPage, MemoryLayer } from "../types.ts";

// Tools describe domain changes; only the runtime applies and persists them.
export type ToolEffect =
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
