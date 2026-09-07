import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Ledger, LogEvent, MemoryRecord, ObservationRecord, ChatMessage, ProviderExchange, Session, Turn } from "../types.ts";
import { nextId, nowIso } from "./ids.ts";

export function defaultDataDir(): string {
  return process.env.TCHROME_DATA || join(homedir(), "Library", "Application Support", "tChrome");
}

const writeJson = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

const readJson = <T>(path: string, fallback: T): T => {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
};

export const paths = (dataDir: string, cvId?: string) => {
  const root = dataDir;
  const conv = cvId ? join(root, "conversations", cvId) : root;
  return {
    root,
    session: join(root, "session.json"),
    conv,
    ledger: join(conv, "ledger.json"),
    events: join(conv, "events.jsonl"),
    provider: join(conv, "provider.md"),
    turns: join(conv, "turns"),
    memory: join(conv, "memory"),
    observations: join(conv, "observations"),
    returns: join(conv, "returns"),
  };
};

export function loadSession(dataDir: string): Session | null {
  return readJson<Session | null>(paths(dataDir).session, null);
}

export function saveSession(dataDir: string, session: Session): void {
  writeJson(paths(dataDir).session, session);
}

export function listConversationIds(dataDir: string): string[] {
  const dir = join(dataDir, "conversations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.startsWith("cv_"));
}

export function emptyLedger(conversationId: string): Ledger {
  const t = nowIso();
  return {
    schemaVersion: 1,
    conversationId,
    createdAt: t,
    updatedAt: t,
    status: "idle",
    active: null,
    pendingAsk: null,
    turnIds: [],
    userInputHistory: [],
    goal: "",
    goalHistory: [],
    toolQueue: [],
    liveTool: null,
    toolIO: [],
    observation: [],
    notes: {},
    windowChars: 0,
    compressAt: 200000,
    memoryIds: { turn: [], conversation: [], project: [] },
    contextSummary: null,
  };
}

export function loadLedger(dataDir: string, cvId: string): Ledger {
  const ledger = readJson(paths(dataDir, cvId).ledger, emptyLedger(cvId));
  ledger.goal ??= "";
  ledger.goalHistory ??= [];
  ledger.notes ??= {};
  return ledger;
}

export function saveLedger(dataDir: string, ledger: Ledger): void {
  ledger.updatedAt = nowIso();
  writeJson(paths(dataDir, ledger.conversationId).ledger, ledger);
}

export function loadTurn(dataDir: string, cvId: string, turnId: string): Turn {
  return JSON.parse(readFileSync(join(paths(dataDir, cvId).turns, `${turnId}.json`), "utf8")) as Turn;
}

export function saveTurn(dataDir: string, turn: Turn): void {
  writeJson(join(paths(dataDir, turn.conversationId).turns, `${turn.turnId}.json`), turn);
}

export function loadMemory(dataDir: string, cvId: string, memoryId: string): MemoryRecord {
  return JSON.parse(readFileSync(join(paths(dataDir, cvId).memory, `${memoryId}.json`), "utf8")) as MemoryRecord;
}

export function saveMemory(dataDir: string, cvId: string, record: MemoryRecord): void {
  writeJson(join(paths(dataDir, cvId).memory, `${record.memoryId}.json`), record);
}

export function loadObservation(dataDir: string, cvId: string, observationId: string): ObservationRecord | null {
  const path = join(paths(dataDir, cvId).observations, `${observationId}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as ObservationRecord;
}

export function saveObservation(dataDir: string, cvId: string, record: ObservationRecord): void {
  writeJson(join(paths(dataDir, cvId).observations, `${record.observationId}.json`), record);
}

export function saveFullReturn(dataDir: string, cvId: string, callId: string, full: string): void {
  const dir = paths(dataDir, cvId).returns;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${callId}.txt`), full);
}

export function loadFullReturn(dataDir: string, cvId: string, callId: string): string | null {
  const path = join(paths(dataDir, cvId).returns, `${callId}.txt`);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

export function appendEvent(dataDir: string, cvId: string, event: Omit<LogEvent, "at"> & { at?: string }): void {
  const line: LogEvent = { at: event.at ?? nowIso(), kind: event.kind, turnId: event.turnId, data: event.data };
  const path = paths(dataDir, cvId).events;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(line)}\n`);
}

export function loadEvents(dataDir: string, cvId: string): LogEvent[] {
  const path = paths(dataDir, cvId).events;
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEvent);
}

export function loadProviderLog(dataDir: string, cvId: string): ProviderExchange[] {
  const path = paths(dataDir, cvId).provider;
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const rows: ProviderExchange[] = [];
  for (const block of text.split(/\n(?=## )/)) {
    const heading = block.match(/^## (tn_\S+) \/ (\d+)/);
    if (!heading) continue;
    const json = block.match(/```json\n([\s\S]*?)\n```/);
    if (!json?.[1]) continue;
    rows.push(JSON.parse(json[1]) as ProviderExchange);
  }
  return rows;
}

const fence = (label: string, body: string) => `### ${label}\n\n\`\`\`\n${body}\n\`\`\`\n`;

const renderProviderExchange = (row: ProviderExchange, messages: ChatMessage[], content: string) => {
  const calls = row.response.toolCalls.map((call) => `${call.name} ${JSON.stringify(call.arguments)}`).join("\n") || "(none)";
  return [
    `## ${row.turnId} / ${row.outbound}`,
    "",
    "```json",
    JSON.stringify(row, null, 2),
    "```",
    "",
    fence("system", messages.find((item) => item.role === "system")?.content ?? ""),
    fence("user", messages.find((item) => item.role === "user")?.content ?? ""),
    fence("content", content),
    fence("tool_calls", calls),
  ].join("\n");
};

export function appendProviderExchange(
  dataDir: string,
  cvId: string,
  exchange: Omit<ProviderExchange, "at" | "outbound"> & { at?: string; messages: ChatMessage[]; content: string },
): ProviderExchange {
  const log = loadProviderLog(dataDir, cvId);
  const row: ProviderExchange = {
    at: exchange.at ?? nowIso(),
    turnId: exchange.turnId,
    outbound: log.filter((item) => item.turnId === exchange.turnId).length + 1,
    request: exchange.request,
    response: exchange.response,
  };
  const path = paths(dataDir, cvId).provider;
  mkdirSync(dirname(path), { recursive: true });
  const chunk = `${renderProviderExchange(row, exchange.messages, exchange.content)}\n`;
  if (existsSync(path)) appendFileSync(path, `\n${chunk}`);
  else writeFileSync(path, chunk);
  return row;
}

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

export function sessionView(dataDir: string, cvId: string): SessionView {
  const ledger = loadLedger(dataDir, cvId);
  const events = loadEvents(dataDir, cvId);
  const messages: SessionMessage[] = [];
  for (const turnId of ledger.turnIds) {
    const turn = loadTurn(dataDir, cvId, turnId);
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
  return { conversationId: cvId, status: ledger.status, pendingAsk, liveTool: ledger.liveTool, messages };
}

export function currentSessionView(dataDir: string): SessionView {
  const session = loadSession(dataDir);
  if (!session?.conversationId) {
    return { conversationId: null, status: "idle", pendingAsk: null, liveTool: null, messages: [] };
  }
  return sessionView(dataDir, session.conversationId);
}

export function listConversations(dataDir: string): ConversationItem[] {
  const current = loadSession(dataDir)?.conversationId ?? null;
  return listConversationIds(dataDir)
    .map((id) => {
      const ledger = loadLedger(dataDir, id);
      const lastTurnId = ledger.turnIds.at(-1);
      let preview = "新会话";
      if (lastTurnId) preview = loadTurn(dataDir, id, lastTurnId).input.text;
      else if (ledger.userInputHistory.at(-1)) preview = ledger.userInputHistory.at(-1) ?? "新会话";
      return {
        conversationId: id,
        updatedAt: ledger.updatedAt,
        status: ledger.status,
        preview: preview.slice(0, 40),
      };
    })
    .sort((a, b) => {
      if (a.conversationId === current) return -1;
      if (b.conversationId === current) return 1;
      if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
      return a.conversationId < b.conversationId ? 1 : -1;
    });
}

export function openConversation(dataDir: string, conversationId: string): SessionView {
  if (!listConversationIds(dataDir).includes(conversationId)) {
    throw new Error("没有这个会话");
  }
  saveSession(dataDir, { conversationId });
  appendEvent(dataDir, conversationId, { kind: "session", data: { conversationId, action: "open" } });
  return sessionView(dataDir, conversationId);
}

export function newConversation(dataDir: string): SessionView {
  const conversationId = nextId("cv_", listConversationIds(dataDir));
  saveSession(dataDir, { conversationId });
  saveLedger(dataDir, emptyLedger(conversationId));
  appendEvent(dataDir, conversationId, { kind: "session", data: { conversationId, action: "new" } });
  return sessionView(dataDir, conversationId);
}

export function deleteConversation(dataDir: string, conversationId: string): SessionView {
  if (!listConversationIds(dataDir).includes(conversationId)) {
    throw new Error("没有这个会话");
  }
  const current = loadSession(dataDir)?.conversationId;
  rmSync(paths(dataDir, conversationId).conv, { recursive: true, force: true });
  if (current !== conversationId) return currentSessionView(dataDir);
  const remaining = listConversations(dataDir);
  if (remaining[0]) return openConversation(dataDir, remaining[0].conversationId);
  return newConversation(dataDir);
}

export function ensureSession(dataDir: string): Session {
  const existing = loadSession(dataDir);
  if (existing?.conversationId) return existing;
  const conversationId = nextId("cv_", listConversationIds(dataDir));
  const session = { conversationId };
  saveSession(dataDir, session);
  saveLedger(dataDir, emptyLedger(conversationId));
  appendEvent(dataDir, conversationId, { kind: "session", data: { conversationId } });
  return session;
}

export function stopTurn(dataDir: string): SessionView {
  const session = loadSession(dataDir);
  if (!session?.conversationId) return currentSessionView(dataDir);
  const ledger = loadLedger(dataDir, session.conversationId);
  if (ledger.status !== "running") return sessionView(dataDir, session.conversationId);
  const turnId = ledger.active?.turnId;
  if (turnId) {
    const turn = loadTurn(dataDir, session.conversationId, turnId);
    turn.status = "failed";
    turn.completedAt = nowIso();
    turn.output = { kind: "error", faultCode: "stopped" };
    saveTurn(dataDir, turn);
    appendEvent(dataDir, session.conversationId, { kind: "turn-output", turnId, data: { output: turn.output } });
  }
  ledger.status = "paused";
  ledger.active = null;
  ledger.pendingAsk = null;
  ledger.toolQueue = [];
  ledger.liveTool = null;
  saveLedger(dataDir, ledger);
  appendEvent(dataDir, session.conversationId, { kind: "session", data: { conversationId: session.conversationId, action: "stop" } });
  return sessionView(dataDir, session.conversationId);
}
