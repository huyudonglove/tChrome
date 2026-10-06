import type { BlockIndex } from "../evidence/index.ts";
import type { CurrentPage, MemoryLayer } from "../types.ts";
import type { QueryEvidence } from "../context/projections/queries.ts";

// Tools describe domain changes; only the runtime applies and persists them.
export type ToolEffect =
  | { type: "query.set"; query: Omit<QueryEvidence, "queryId" | "turnId" | "sourceCallId"> }
  | { type: "note.write"; key: string; value: string }
  | { type: "note.delete"; key: string }
  | { type: "memory.append"; entries: { layer: MemoryLayer; scope?: string; summary?: string; text: string }[] }
  | { type: "memory_update"; memoryId: string; text: string }
  | { type: "memory_delete"; memoryId: string }
  | { type: "tools.enable"; names: string[] }
  | { type: "tools.disable"; names: string[] }
  | { type: "skill_load"; id: string }
  | { type: "page.set"; page: CurrentPage; result: Record<string, unknown> }
  | { type: "observation_write"; observationType: string; result: unknown; tabId?: number; validForTurns?: number; refresh?: string }
  | { type: "page_clear_result"; pageId: string }
  | { type: "task_set"; title?: string; items: { text: string; status?: "todo" | "doing" | "done"; expectedEffect?: string; verification?: string }[] }
  | { type: "task_update"; taskId?: string; items: { id: string; status?: "todo" | "doing" | "done"; text?: string; expectedEffect?: string; verification?: string; blockedReason?: string }[] }
  | { type: "task_complete"; taskId?: string; reason?: string }
  | { type: "reflect_write"; id: string; text: string; focus?: string; replace?: boolean }
  | { type: "reflect_delete"; id: string }
  | { type: "tab_context.set"; tabId: number }
  | { type: "tab_context.clear" }
  | { type: "turn.ask"; question: string }
  | { type: "turn.reply"; text: string }
  | { type: "queue.clear" };

/** admitted=true 表示本工具的 text 已按门禁预算主动裁剪过（取回型工具），
 *  门禁编排处应直接内联，不再二次外置成指针，否则会出现「取回→外置→再取回」死循环。 */
export type ToolExecution = { text: string; effects: ToolEffect[]; admitted?: boolean; evidenceIndex?: BlockIndex };
