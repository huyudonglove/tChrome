import type { Ledger, LoopRecord, LoopToolResult, Task } from "../../types.ts";
import type { MemoryRecord } from "../../memory/types.ts";
import { loopSummaryView, type LoopSummary } from "./records.ts";

const taskView = (task: Task) => ({
  id: task.id, title: task.title, status: task.status, items: task.items,
});
export type ConversationTaskPayload = ReturnType<typeof taskView>[];
export type ConversationPayload = {
  conversationMemory: MemoryRecord[] | string;
  conversationHistorySummary: ReturnType<typeof loopSummaryView> | string;
  tasks: ConversationTaskPayload;
  loops: LoopRecord[];
};

type CallResult = LoopToolResult;
const results = (loop: LoopRecord): CallResult[] => loop.runtime.flatMap(row =>
  row.type === "callsResult" && Array.isArray(row.content) ? row.content as CallResult[] : []);

/** Retention is the resolved execution-time value, never re-read from mutable tool metadata. */
export function conversationPayload(input: {
  ledger: Ledger;
  memories: { conversation: MemoryRecord[] | string };
  conversationSummaries?: LoopSummary[] | string;
}): ConversationPayload {
  const loops = input.ledger.loops;
  const currentLoop = loops.at(-1);
  const visible = new Set<string>();
  const known = new Set<string>();
  for (const loop of loops) for (const row of results(loop)) {
    known.add(row.callId);
    if (row.keepInCalls || loop.id === currentLoop?.id) visible.add(row.callId);
  }
  return {
    conversationMemory: input.memories.conversation,
    conversationHistorySummary: Array.isArray(input.conversationSummaries)
      ? loopSummaryView(input.conversationSummaries) : input.conversationSummaries ?? [],
    tasks: input.ledger.tasks.filter(task => task.status === "active" || task.status === "paused").map(taskView),
    loops: loops.map(loop => ({
      ...loop,
      runtime: loop.runtime.map(row => row.type === "callsResult" && Array.isArray(row.content)
        ? { ...row, content: (row.content as CallResult[]).filter(result => visible.has(result.callId)) } : row)
        .filter(row => row.type !== "callsResult" || !Array.isArray(row.content) || row.content.length > 0),
      ...(loop.helm ? { helm: { ...loop.helm, calls: loop.helm.calls.filter(call => !known.has(call.id) || visible.has(call.id)) } } : {}),
    })),
  };
}
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const attr = (values: Record<string, unknown>) => Object.entries(values).filter(([,value]) => value !== undefined)
  .map(([key,value]) => ` ${key}="${escape(typeof value === "string" ? value : JSON.stringify(value))}"`).join("");
const body = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);
const tag = (name: string, value: unknown, attributes: Record<string, unknown> = {}) => `<${name}${attr(attributes)}>\n${body(value)}\n</${name}>`;
const list = (name: string, value: unknown, id: string) => {
  if (typeof value === "string") { try { return list(name, JSON.parse(value), id); } catch { return value; } }
  if (!Array.isArray(value)) return "";
  return value.map(row => { const { [id]: key, ...rest } = row; return tag(name, rest, { [id]: key }); }).join("\n");
};

/** Immutable loops retain input/response order; mutable active tasks sit at the suffix. */
export function conversationXml(payload: ConversationPayload): string {
  const summaries = list("summary", payload.conversationHistorySummary, "sumId");
  const parts = [list("ConversationMemories", payload.conversationMemory, "memoryId"),
    summaries ? tag("summaries", summaries) : ""];
  for (const loop of payload.loops) {
    const rows = loop.runtime.map(row => tag("runtime", row.content, { id: row.id, type: row.type }));
    if (loop.helm) {
      const { id, ...response } = loop.helm;
      rows.push(tag("helm", response, { id }));
    }
    parts.push(tag("loop", rows.join("\n"), { id: loop.id }));
  }
  if (payload.tasks.length) parts.push(tag("tasks", list("task", payload.tasks, "id")));
  return parts.filter(Boolean).join("\n");
}
