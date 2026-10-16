import type { HelmRecord, Ledger, LoopRecord, LoopToolResult, RuntimeRecord, Task } from "../../types.ts";
import type { MemoryRecord } from "../../memory/types.ts";
import { dateOnly, loopSummaryView, type LoopSummary } from "./records.ts";

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
  local_replace_block: ["search", "replace"],
};

/** provider 传输/协议失败：finish=error 且 faultCode 以 provider_ 开头。仅这类 loop 不进窗口。 */
const isProviderFailure = (helm?: HelmRecord): boolean =>
  helm?.finish === "error" && typeof helm.faultCode === "string" && helm.faultCode.startsWith("provider_");

export function conversationPayload(input: {
  ledger: Ledger;
  memories: { conversation: MemoryRecord[] | string };
  conversationSummaries?: LoopSummary[] | string;
  /** 会话号 → callId → 该调用写入的记忆编号：窗口里写入调用正文只留指针。 */
  memoryPointers?: Record<string, Record<string, string[]>>;
}): ConversationPayload {
  // provider 传输/协议失败（重试耗尽的空回包、超时、连接错误等）模型无能为力，渲染进窗口只是噪音：
  // 这类 loop 整体不进窗口；模型可自纠的失败（工具参数/schema/缺字段）仍完整渲染。
  const loops = input.ledger.loops.filter(loop => !isProviderFailure(loop.helm));
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
    loops: loops.map((loop, index) => ({
      ...loop,
      // notice 是每次发送前重算的临时提醒，只对尚未发送的那条 loop 有效；历史副本已过期，不进窗口。
      runtime: index === loops.length - 1 ? loop.runtime : loop.runtime.filter(row => row.type !== "notice"),
      ...(loop.helm ? { helm: { ...loop.helm, calls: loop.helm.calls.map(call => {
        // 投影只替换送模型的副本：落盘 helm 仍保留完整正文。
        const args = { ...((call.arguments ?? {}) as Record<string, unknown>) };
        let projected = false;
        const ids = input.memoryPointers?.[input.ledger.conversationId]?.[call.id];
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

/**
 * helm 记录的默认值不进窗口：正常态只剩 content 与 calls；finish 非 tool_calls、parseOk/schemaOk 为
 * false、有 faultCode/missing 时仍完整渲染，失败诊断线索不丢。落盘记录与查询侧不受影响。
 * 例外：provider 传输/协议失败（faultCode 以 provider_ 开头）的 loop 在 conversationPayload 就被整体
 * 排除，不会走到这里——这类失败模型无能为力，渲染进窗口只是噪音。
 */
const helmView = (helm: HelmRecord) => ({
  ...(helm.content ? { content: helm.content } : {}),
  calls: helm.calls,
  ...(helm.finish !== "tool_calls" ? { finish: helm.finish } : {}),
  ...(helm.faultCode ? { faultCode: helm.faultCode } : {}),
  ...(helm.detail ? { detail: helm.detail } : {}),
  ...(helm.parseOk === false ? { parseOk: helm.parseOk } : {}),
  ...(helm.schemaOk === false ? { schemaOk: helm.schemaOk } : {}),
  ...(helm.missing?.length ? { missing: helm.missing } : {}),
  ...(helm.grounding ? { grounding: helm.grounding } : {}),
  ...(helm.toolCallFaults?.length ? { toolCallFaults: helm.toolCallFaults } : {}),
});
/** userInput 的运行时正文只保留 text：submittedAt 是落盘时间戳，模型侧不需要。 */
const runtimeView = (row: RuntimeRecord) => {
  const content = row.content;
  if (row.type !== "userInput" || !content || typeof content !== "object" || Array.isArray(content)) return content;
  const rest = { ...(content as Record<string, unknown>) };
  delete rest.submittedAt;
  return rest;
};

/** 摘要存在即代表更早的 loop 已被压缩：这是持久标记，不随 notice 每轮重算消失。 */
const SUMMARY_NOTE = "更早的 loop 已压缩为摘要，原文可按 loopIds 回查";

/** Immutable loops retain input/response order; mutable active tasks sit at the suffix. */
export function conversationXml(payload: ConversationPayload): string {
  const summaries = list("summary", payload.conversationHistorySummary, "sumId");
  const parts = [list("ConversationMemories", payload.conversationMemory, "memoryId"),
    summaries ? tag("summaries", summaries, { note: SUMMARY_NOTE }) : ""];
  for (const [index, loop] of payload.loops.entries()) {
    const rows = loop.runtime.map(row => tag("runtime", runtimeView(row), { id: row.id, type: row.type }));
    if (loop.helm) {
      rows.push(tag("helm", helmView(loop.helm), { id: loop.helm.id }));
    }
    // 只有最新 loop 带日期：它与最早摘要的日期一起界定窗口跨度，逐条加日期属无谓噪音。
    const date = index === payload.loops.length - 1 ? dateOnly(loop.createdAt) : undefined;
    parts.push(tag("loop", rows.join("\n"), { id: loop.id, ...(date ? { date } : {}) }));
  }
  if (payload.tasks.length) parts.push(tag("tasks", list("task", payload.tasks, "id")));
  return parts.filter(Boolean).join("\n");
}
