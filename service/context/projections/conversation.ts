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

/** 写盘类工具的大块正文参数：调用执行完后，窗口里只留文件名或路径。 */
const writeBodyKeys: Record<string, string[]> = {
  script_write: ["code"], script_patch: ["patch"], local_fs_write: ["content"], local_apply_patch: ["patch"],
};

export function conversationPayload(input: {
  ledger: Ledger;
  memories: { conversation: MemoryRecord[] | string };
  conversationSummaries?: LoopSummary[] | string;
  /** callId → 该调用写入的记忆编号：窗口里写入调用正文只留指针。 */
  memoryPointers?: Record<string, string[]>;
}): ConversationPayload {
  const loops = input.ledger.loops;
  // 只有执行完（callsResult 里出现过）的写盘调用才剥离正文，被打断的调用仍完整保留。
  const executedCallIds = new Set<string>();
  for (const loop of loops) for (const row of loop.runtime) {
    if (row.type !== "callsResult" || !Array.isArray(row.content)) continue;
    for (const item of row.content as LoopToolResult[]) if (item?.callId) executedCallIds.add(item.callId);
  }
  return {
    conversationMemory: input.memories.conversation,
    conversationHistorySummary: Array.isArray(input.conversationSummaries)
      ? loopSummaryView(input.conversationSummaries) : input.conversationSummaries ?? [],
    tasks: input.ledger.tasks.filter(task => task.status === "active" || task.status === "paused").map(taskView),
    loops: loops.map(loop => ({
      ...loop,
      ...(loop.helm ? { helm: { ...loop.helm, calls: loop.helm.calls.map(call => {
        // 投影只替换送模型的副本：落盘 helm 仍保留完整正文。
        const args = { ...((call.arguments ?? {}) as Record<string, unknown>) };
        let projected = false;
        const ids = input.memoryPointers?.[call.id];
        if (ids?.length) {
          // memory_update 的 text 同属记忆正文，同样只留指针，避免第二份正文进窗口。
          delete args.conversationMemory; delete args.projectMemory; delete args.summary; delete args.text;
          args.memoryPointers = ids;
          projected = true;
        }
        // 写盘类调用执行完，窗口只留文件名或路径。
        if (executedCallIds.has(call.id)) {
          for (const key of writeBodyKeys[call.name] ?? []) if (key in args) { delete args[key]; projected = true; }
        }
        return projected ? { ...call, arguments: args as typeof call.arguments } : call;
      }) } } : {}),
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
