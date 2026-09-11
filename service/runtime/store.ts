import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Ledger, LogEvent, ObservationRecord, ChatMessage, ProviderExchange, Session, Turn } from "../types.ts";
import { nextId, nowIso } from "./ids.ts";
import { abortLocalProcesses } from "../tools/local-process.ts";
import { localScope } from "../tools/local-tools.ts";
import { migrateConversationMemory, migrateProjectMemories } from "../memory/store.ts";
import { emptySessionView, projectConversationList, projectSessionView } from "../presentation/session-view.ts";
import type { ConversationItem, SessionView } from "../presentation/session-view.ts";
export type { ConversationItem, SessionMessage, SessionView } from "../presentation/session-view.ts";

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
    memoryIds: { conversation: [], project: [] },
    contextSummary: null,
  };
}

export function loadLedger(dataDir: string, cvId: string): Ledger {
  const ledger = readJson(paths(dataDir, cvId).ledger, emptyLedger(cvId));
  ledger.goal ??= "";
  ledger.goalHistory ??= [];
  ledger.notes ??= {};
  const memoryIds = migrateConversationMemory(dataDir, cvId, ledger.memoryIds);
  if (JSON.stringify(memoryIds) !== JSON.stringify(ledger.memoryIds)) {
    ledger.memoryIds = memoryIds;
    writeJson(paths(dataDir, cvId).ledger, ledger);
  }
  return ledger;
}

export function saveLedger(dataDir: string, ledger: Ledger): void {
  ledger.updatedAt = nowIso();
  writeJson(paths(dataDir, ledger.conversationId).ledger, ledger);
}

export function loadTurn(dataDir: string, cvId: string, turnId: string): Turn {
  const turn = JSON.parse(readFileSync(join(paths(dataDir, cvId).turns, `${turnId}.json`), "utf8")) as Turn;
  turn.assembled.pageObservedHistory ??= [];
  return turn;
}

export function saveTurn(dataDir: string, turn: Turn): void {
  writeJson(join(paths(dataDir, turn.conversationId).turns, `${turn.turnId}.json`), turn);
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
    ...(messages.some(item => item.images?.length) ? [fence("images", JSON.stringify(messages.flatMap(item => item.images ?? []), null, 2))] : []),
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

export function sessionView(dataDir: string, cvId: string): SessionView {
  const ledger = loadLedger(dataDir, cvId);
  return projectSessionView({
    ledger,
    events: loadEvents(dataDir, cvId),
    turns: ledger.turnIds.map((turnId) => loadTurn(dataDir, cvId, turnId)),
  });
}

export function currentSessionView(dataDir: string): SessionView {
  const session = loadSession(dataDir);
  if (!session?.conversationId) {
    return emptySessionView();
  }
  return sessionView(dataDir, session.conversationId);
}

export function listConversations(dataDir: string): ConversationItem[] {
  return projectConversationList(listConversationIds(dataDir).map((id) => {
    const ledger = loadLedger(dataDir, id);
    const lastTurnId = ledger.turnIds.at(-1);
    return { ledger, lastTurn: lastTurnId ? loadTurn(dataDir, id, lastTurnId) : null };
  }));
}

export function openConversation(dataDir: string, conversationId: string): SessionView {
  if (!listConversationIds(dataDir).includes(conversationId)) {
    throw new Error("没有这个会话");
  }
  saveSession(dataDir, { conversationId });
  appendEvent(dataDir, conversationId, { kind: "session", data: { conversationId, action: "open" } });
  return sessionView(dataDir, conversationId);
}

// Keep the allocation watermark outside deletable conversation directories.
// Existing installations migrate from their highest surviving conversation ID.
const allocateConversationId = (dataDir: string): string => {
  const path = join(dataDir, "conversation-id.json");
  const previous = readJson<string | null>(path, null);
  const conversationId = nextId("cv_", [...listConversationIds(dataDir), ...(previous ? [previous] : [])]);
  writeJson(path, conversationId);
  return conversationId;
};

export function newConversation(dataDir: string): SessionView {
  const conversationId = allocateConversationId(dataDir);
  saveSession(dataDir, { conversationId });
  saveLedger(dataDir, emptyLedger(conversationId));
  appendEvent(dataDir, conversationId, { kind: "session", data: { conversationId, action: "new" } });
  return sessionView(dataDir, conversationId);
}

export function deleteConversation(dataDir: string, conversationId: string): SessionView {
  if (!listConversationIds(dataDir).includes(conversationId)) {
    throw new Error("没有这个会话");
  }
  migrateProjectMemories(dataDir);
  // Persist the high watermark before removing legacy directories too.
  const watermarkPath = join(dataDir, "conversation-id.json");
  const previous = readJson<string | null>(watermarkPath, null);
  const highest = [...listConversationIds(dataDir), ...(previous ? [previous] : [])]
    .sort((a, b) => Number(b.slice(3)) - Number(a.slice(3)))[0];
  if (highest) writeJson(watermarkPath, highest);
  const current = loadSession(dataDir)?.conversationId;
  abortLocalProcesses(localScope(dataDir, conversationId));
  rmSync(paths(dataDir, conversationId).conv, { recursive: true, force: true });
  if (current !== conversationId) return currentSessionView(dataDir);
  const remaining = listConversations(dataDir);
  if (remaining[0]) return openConversation(dataDir, remaining[0].conversationId);
  return newConversation(dataDir);
}

export function ensureSession(dataDir: string): Session {
  const existing = loadSession(dataDir);
  if (existing?.conversationId) return existing;
  const conversationId = allocateConversationId(dataDir);
  const session = { conversationId };
  saveSession(dataDir, session);
  saveLedger(dataDir, emptyLedger(conversationId));
  appendEvent(dataDir, conversationId, { kind: "session", data: { conversationId } });
  return session;
}

export function stopTurn(dataDir: string): SessionView {
  const session = loadSession(dataDir);
  if (!session?.conversationId) return currentSessionView(dataDir);
  abortLocalProcesses(localScope(dataDir, session.conversationId));
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
