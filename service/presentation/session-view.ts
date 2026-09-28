import { errorMessage } from "../../shared/errors.ts";
import type { Ledger, LogEvent, Turn } from "../types.ts";

const stopReasonText = (output: Turn["stopReason"]): string => {
  if (!output) return "";
  if (output.kind === "reply") return output.text;
  if (output.kind === "ask") return output.question;
  if (output.kind === "error") {
    return errorMessage(output.faultCode, "user");
  }
  if (output.kind === "interrupted") {
    const who = output.initiatedBy === "user" ? "用户" : output.initiatedBy === "budget" ? "预算" : "服务";
    return [`已中断（${who}）`, output.detail || ""].filter(Boolean).join("\n");
  }
  return `${output.name} ${output.callId}`;
};

export type SessionMessage = {
  turnId: string;
  role: "user" | "assistant" | "tool";
  text: string;
  name?: string;
  live?: boolean;
};

export type SessionView = {
  conversationId: string | null;
  status: Ledger["status"] | "idle";
  pendingAsk: { turnId: string; question: string; choice: string[] } | null;
  liveTools: { name: string; callId: string; reason?: string }[];
  activity: { kind: "compressing"; source: "agent" | "runtime"; phase: "history" | "current" | "summaries" | null; completed: number; total: number | null } | null;
  task: {
    activeTaskId: string | null;
    activeTaskItemId: string | null;
    task: {
      id: string;
      title?: string;
      status: string;
      items: { id: string; text: string; status: string; blockedReason?: string }[];
    } | null;
  };
  messages: SessionMessage[];
};

export type ConversationItem = {
  conversationId: string;
  updatedAt: string;
  status: Ledger["status"];
  preview: string;
};

const toolText = (row: { arguments?: { reason?: unknown } }, fallback = "工具调用已结束"): string => {
  const reason = row.arguments?.reason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : fallback;
};

const pushLiveTools = (input: {
  messages: SessionMessage[];
  ledger: Ledger;
  turnId: string;
}) => {
  const { messages, ledger, turnId } = input;
  if (ledger.active?.turnId !== turnId) return;
  const liveIds = new Set(ledger.liveTools.map((item) => item.callId));
  for (const live of ledger.liveTools) {
    if (live.name === "finishTurn" || live.name === "askUser") continue;
    const reason = typeof live.reason === "string" && live.reason.trim() ? live.reason.trim() : "";
    messages.push({
      turnId,
      role: "tool",
      text: reason || `正在执行 ${live.name}`,
      name: live.name,
      live: true,
    });
  }
  for (const item of ledger.toolQueue) {
    if (liveIds.has(item.callId)) continue;
    if (item.name === "finishTurn" || item.name === "askUser") continue;
    messages.push({ turnId, role: "tool", text: toolText(item, `等待执行 ${item.name}`), name: item.name });
  }
};

const compressionActivity = (ledger: Ledger, events: LogEvent[]): SessionView["activity"] => {
  if (ledger.status !== "running" || !ledger.active) return null;
  let activity: SessionView["activity"] = null;
  for (const event of events) {
    if (event.turnId !== ledger.active.turnId) continue;
    if (event.kind === "compress-start") activity = { kind: "compressing", source: event.data.source === "agent" ? "agent" : "runtime", phase: null, completed: 0, total: null };
    if (event.kind === "compress-phase" && activity) {
      const phase = event.data.phase;
      if (phase === "history" || phase === "current" || phase === "summaries") activity.phase = phase;
    }
    if (event.kind === "compress-progress" && activity) {
      const completed = event.data.completed;
      const total = event.data.total;
      if (typeof completed === "number" && completed >= 0) activity.completed = completed;
      if (typeof total === "number" && total >= 0) activity.total = total;
    }
    if (event.kind === "compress" || event.kind === "compress-error") activity = null;
  }
  return activity;
};

export function projectSessionView({ ledger, events, turns }: {
  ledger: Ledger;
  events: LogEvent[];
  turns: Turn[];
}): SessionView {
  const messages: SessionMessage[] = [];
  for (const turn of turns) {
    const turnId = turn.turnId;
    messages.push({ turnId, role: "user", text: turn.input.text });
    const turnEvents = events.filter((event) => event.turnId === turnId);
    // Tool arguments supply progress; only turn.stopReason supplies the final reply.
    // Provider content and raw tool results stay in the logs.
    for (const event of turnEvents) {
      if (event.kind !== "tool") continue;
      const name = String(event.data.name ?? "");
      if (name === "finishTurn" || name === "askUser") continue;
      const row = event.data as { arguments?: { reason?: unknown } };
      messages.push({ turnId, role: "tool", text: toolText(row), name });
    }
    if (!turnEvents.some((event) => event.kind === "tool")) {
      // Older conversations can have toolIO without tool events.
      for (const row of ledger.toolIO) {
        if (row.turnId !== turnId) continue;
        if (row.name === "finishTurn" || row.name === "askUser") continue;
        messages.push({ turnId, role: "tool", text: toolText(row), name: row.name });
      }
    }
    pushLiveTools({ messages, ledger, turnId });
    if (turn.stopReason && turn.stopReason.kind !== "tool") {
      messages.push({ turnId, role: "assistant", text: stopReasonText(turn.stopReason) });
    }
  }
  let pendingAsk: SessionView["pendingAsk"] = null;
  if (ledger.pendingAsk) {
    const lastAsk = [...ledger.toolIO].reverse().find((row) => row.name === "askUser");
    const raw = lastAsk?.arguments.choice;
    const choice = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
    pendingAsk = { turnId: ledger.pendingAsk.turnId, question: ledger.pendingAsk.question, choice };
  }
  return { conversationId: ledger.conversationId, status: ledger.status, pendingAsk, liveTools: ledger.liveTools,
    activity: compressionActivity(ledger, events), task: taskView(ledger), messages };
}

const taskView = (ledger: Ledger): SessionView["task"] => {
  const plan = ledger.activeTaskId ? ledger.tasks.find((row) => row.id === ledger.activeTaskId) ?? null : null;
  return {
    activeTaskId: ledger.activeTaskId,
    activeTaskItemId: ledger.activeTaskItemId,
    task: plan
      ? {
        id: plan.id,
        ...(plan.title ? { title: plan.title } : {}),
        status: plan.status,
        items: plan.items.map((item) => ({
          id: item.id,
          text: item.text,
          status: item.status,
          ...(item.blockedReason ? { blockedReason: item.blockedReason } : {}),
        })),
      }
      : null,
  };
};

export const emptySessionView = (): SessionView => ({
  conversationId: null, status: "idle", pendingAsk: null, liveTools: [], activity: null,
  task: { activeTaskId: null, activeTaskItemId: null, task: null },
  messages: [],
});

export function projectConversationList(rows: { ledger: Ledger; lastTurn: Turn | null }[]): ConversationItem[] {
  return rows
    .map(({ ledger, lastTurn }) => {
      let preview = "新会话";
      if (lastTurn) preview = lastTurn.input.text;
      else if (ledger.userInputHistory.at(-1)) preview = ledger.userInputHistory.at(-1)?.userInput ?? "新会话";
      return {
        conversationId: ledger.conversationId,
        createdAt: ledger.createdAt,
        updatedAt: ledger.updatedAt,
        status: ledger.status,
        preview: preview.slice(0, 40),
      };
    })
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return b.conversationId.localeCompare(a.conversationId, undefined, { numeric: true });
    });
}
