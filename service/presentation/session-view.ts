import type { Ledger, LogEvent, Turn } from "../types.ts";

const outputText = (output: Turn["output"]): string => {
  if (!output) return "";
  if (output.kind === "reply") return output.text;
  if (output.kind === "ask") return output.question;
  if (output.kind === "error") {
    const messages: Record<string, string> = {
      stopped: "已停止",
      max_outbounds: "本轮已达到执行次数上限，任务还没有完成。你可以缩小任务范围，或让我继续处理剩余部分。",
      provider_error: "模型服务暂时没有正常响应，本轮未完成。请稍后重试。",
      provider_key_missing: "尚未配置模型服务密钥，请先在本机服务中完成配置。",
      provider_key_invalid: "模型服务密钥无效或权限不足，请检查配置。",
      need_finish_turn: "模型没有生成有效的最终回复，本轮未完成。请重试。",
      empty_finish_turn: "模型连续返回了空回复，本轮已停止。请重试。",
    };
    return messages[output.faultCode] ?? "本轮执行遇到错误，未能完成。请重试；详细错误已保留在服务日志中。";
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
  liveTool: { name: string; callId: string } | null;
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

const providerReason = (content: unknown): string => {
  if (typeof content !== "string") return "";
  return content.replaceAll("\r\n", "\n").match(/(?:^|\n)reason\n([\s\S]*?)(?=\naction\n|$)/i)?.[1]?.trim() ?? "";
};

const pushLiveTools = (input: {
  messages: SessionMessage[];
  ledger: Ledger;
  turnId: string;
}) => {
  const { messages, ledger, turnId } = input;
  if (ledger.active?.turnId !== turnId) return;
  if (ledger.liveTool && ledger.liveTool.name !== "finishTurn" && ledger.liveTool.name !== "askUser") {
    const queued = ledger.toolQueue.find((item) => item.callId === ledger.liveTool?.callId);
    messages.push({
      turnId,
      role: "tool",
      text: toolText({ arguments: queued?.arguments }, "正在执行工具"),
      name: ledger.liveTool.name,
      live: true,
    });
  }
  for (const item of ledger.toolQueue) {
    if (item.callId === ledger.liveTool?.callId) continue;
    if (item.name === "finishTurn" || item.name === "askUser") continue;
    messages.push({ turnId, role: "tool", text: toolText(item, "等待执行工具"), name: item.name });
  }
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
    // Reasons are progress messages; only turn.output supplies the final reply.
    // Observations, intermediate actions and raw tool results stay in the logs.
    for (const event of turnEvents) {
      if (event.kind === "provider-response") {
        const reason = providerReason(event.data.content);
        if (reason) messages.push({ turnId, role: "tool", text: reason });
      }
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
    if (turn.output && turn.output.kind !== "tool") {
      messages.push({ turnId, role: "assistant", text: outputText(turn.output) });
    }
  }
  let pendingAsk: SessionView["pendingAsk"] = null;
  if (ledger.pendingAsk) {
    const lastAsk = [...ledger.toolIO].reverse().find((row) => row.name === "askUser");
    const raw = lastAsk?.arguments.choice;
    const choice = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
    pendingAsk = { turnId: ledger.pendingAsk.turnId, question: ledger.pendingAsk.question, choice };
  }
  return { conversationId: ledger.conversationId, status: ledger.status, pendingAsk, liveTool: ledger.liveTool, messages };
}

export const emptySessionView = (): SessionView => ({
  conversationId: null, status: "idle", pendingAsk: null, liveTool: null, messages: [],
});

export function projectConversationList(rows: { ledger: Ledger; lastTurn: Turn | null }[]): ConversationItem[] {
  return rows
    .map(({ ledger, lastTurn }) => {
      let preview = "新会话";
      if (lastTurn) preview = lastTurn.input.text;
      else if (ledger.userInputHistory.at(-1)) preview = ledger.userInputHistory.at(-1) ?? "新会话";
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

