import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { Ledger, LogEvent, ChatMessage, ProviderExchange, Session, Turn } from "../types.ts";
import { runtimeConfig } from "../config/runtime.ts";
import { idPrefix, nextId, nowIso } from "./ids.ts";
import { wrapCachedText } from "./cache-lines.ts";
import { appendAsset, textSummary } from "../assets/catalog.ts";
import { abortLocalProcesses } from "../tools/local-process.ts";
import { abortJobsForScope, jobScope } from "../tools/job-registry.ts";
import { localScope } from "../tools/local-tools.ts";
import { cancelExecution } from "./execution.ts";
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
    providerSystem: join(conv, "provider-system.md"),
    turns: join(conv, "turns"),
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
    loadedToolIds: [],
    loadedSkillIds: [],
    loadedSkillIds: [],
    userInputHistory: [],
    goals: [],
    currentGoalId: null,
    toolQueue: [],
    liveTool: null,
    toolIO: [],
    lastAction: null,
    checklist: null,
    contextTab: null,
    notes: {},
    currentQuery: null,
    queryHistory: [],
    windowChars: 0,
    compressAt: runtimeConfig.context.compressAtChars,
    memoryIds: { conversation: [], project: [] },
  };
}

export function loadLedger(dataDir: string, cvId: string): Ledger {
  const ledger = readJson(paths(dataDir, cvId).ledger, emptyLedger(cvId));
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


export function saveFullReturn(dataDir: string, cvId: string, callId: string, full: string): void {
  const dir = paths(dataDir, cvId).returns;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${callId}.txt`);
  writeFileSync(path, wrapCachedText(full));
  appendAsset(dataDir, cvId, {
    name: `${callId}.txt`,
    kind: "text",
    bytes: Buffer.byteLength(full, "utf8"),
    summary: textSummary(full),
    source: { callId },
    path: `returns/${callId}.txt`,
  });
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
  const payload = `${JSON.stringify(line)}\n`;
  rotateLogIfNeeded(path, Buffer.byteLength(payload, "utf8"));
  if (existsSync(path)) appendFileSync(path, payload);
  else writeFileSync(path, payload);
}

export function loadEvents(dataDir: string, cvId: string): LogEvent[] {
  const conv = paths(dataDir, cvId).conv;
  const active = paths(dataDir, cvId).events;
  const archives = existsSync(conv)
    ? readdirSync(conv)
        .filter((name) => /^events\.\d+\.jsonl$/.test(name))
        .sort()
        .map((name) => join(conv, name))
    : [];
  const rows: LogEvent[] = [];
  for (const path of [...archives, active]) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      rows.push(JSON.parse(line) as LogEvent);
    }
  }
  return rows;
}

export function loadProviderLog(dataDir: string, cvId: string): ProviderExchange[] {
  const conv = paths(dataDir, cvId).conv;
  const active = paths(dataDir, cvId).provider;
  const archives = existsSync(conv)
    ? readdirSync(conv)
        .filter((name) => /^provider\.\d+\.md$/.test(name))
        .sort()
        .map((name) => join(conv, name))
    : [];
  const rows: ProviderExchange[] = [];
  for (const path of [...archives, active]) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    for (const block of text.split(/\n(?=## )/)) {
      const heading = block.match(/^## (tn_\S+) \/ (\d+)/);
      if (!heading) continue;
      const json = block.match(/```json\n([\s\S]*?)\n```/);
      if (!json?.[1]) continue;
      rows.push(JSON.parse(json[1]) as ProviderExchange);
    }
  }
  return rows;
}

const fence = (label: string, body: string) => `### ${label}\n\n\`\`\`\n${body}\n\`\`\`\n`;

/** Shared cap for append-only conversation logs (provider.md, events.jsonl). */
const LOG_ROTATE_BYTES = 3 * 1024 * 1024;

/**
 * Rotate the active log when size + incoming would exceed 3MB.
 * Archives as `<stem>.NN.<ext>` (provider.01.md, events.01.jsonl); active path stays the write target.
 */
function rotateLogIfNeeded(activePath: string, incomingBytes: number): void {
  if (!existsSync(activePath)) return;
  if (statSync(activePath).size + incomingBytes <= LOG_ROTATE_BYTES) return;
  const dir = dirname(activePath);
  const file = activePath.slice(activePath.lastIndexOf("/") + 1);
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : "";
  const archivePattern = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d+)${ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  let max = 0;
  for (const name of readdirSync(dir)) {
    const match = name.match(archivePattern);
    if (!match) continue;
    const index = Number(match[1]);
    if (Number.isFinite(index) && index > max) max = index;
  }
  renameSync(activePath, join(dir, `${stem}.${String(max + 1).padStart(2, "0")}${ext}`));
}

const systemContentHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** System text is large and mostly stable: store once per content hash, not on every exchange. */
function ensureProviderSystemRecord(providerSystemPath: string, hash: string, systemText: string): void {
  mkdirSync(dirname(providerSystemPath), { recursive: true });
  const marker = `## system ${hash}`;
  if (existsSync(providerSystemPath)) {
    const existing = readFileSync(providerSystemPath, "utf8");
    if (existing.includes(marker)) return;
    appendFileSync(providerSystemPath, `\n${marker}\n\n${fence("system", systemText)}`);
    return;
  }
  writeFileSync(providerSystemPath, `${marker}\n\n${fence("system", systemText)}`);
}

/** Exchange body: metadata + user window + model reply. System full text lives in provider-system.md. */
const renderProviderExchange = (row: ProviderExchange, messages: ChatMessage[], content: string) => {
  const calls = row.response.toolCalls.map((call) => `${call.name} ${JSON.stringify(call.arguments)}`).join("\n") || "(none)";
  return [
    `## ${row.turnId} / ${row.outbound}`,
    "",
    "```json",
    JSON.stringify(row, null, 2),
    "```",
    "",
    fence("user", messages.find((item) => item.role === "user")?.content ?? ""),
    ...(messages.some(item => item.images?.length) ? [fence("images", JSON.stringify(messages.flatMap(item => item.images ?? []), null, 2))] : []),
    fence("content", content),
    fence("tool_calls", calls),
  ].join("\n");
};

export function appendProviderExchange(
  dataDir: string,
  cvId: string,
  exchange: Omit<ProviderExchange, "at" | "outbound" | "systemHash"> & { at?: string; messages: ChatMessage[]; content: string },
): ProviderExchange {
  const log = loadProviderLog(dataDir, cvId);
  const systemText = exchange.messages.find((item) => item.role === "system")?.content ?? "";
  const systemHash = systemContentHash(systemText);
  const row: ProviderExchange = {
    at: exchange.at ?? nowIso(),
    turnId: exchange.turnId,
    outbound: log.filter((item) => item.turnId === exchange.turnId).length + 1,
    systemHash,
    request: exchange.request,
    response: exchange.response,
  };
  const file = paths(dataDir, cvId);
  mkdirSync(dirname(file.provider), { recursive: true });
  ensureProviderSystemRecord(file.providerSystem, systemHash, systemText);
  const chunk = `${renderProviderExchange(row, exchange.messages, exchange.content)}\n`;
  rotateLogIfNeeded(file.provider, Buffer.byteLength(chunk, "utf8"));
  if (existsSync(file.provider)) appendFileSync(file.provider, `\n${chunk}`);
  else writeFileSync(file.provider, chunk);
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
// Include existing conversation IDs when allocating the next ID.
const allocateConversationId = (dataDir: string): string => {
  const path = join(dataDir, "conversation-id.json");
  const previous = readJson<string | null>(path, null);
  const conversationId = nextId(idPrefix("conversation"), [...listConversationIds(dataDir), ...(previous ? [previous] : [])]);
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
  // Preserve the allocation watermark before deleting the conversation.
  const watermarkPath = join(dataDir, "conversation-id.json");
  const previous = readJson<string | null>(watermarkPath, null);
  const highest = [...listConversationIds(dataDir), ...(previous ? [previous] : [])]
    .sort((a, b) => Number(b.slice(3)) - Number(a.slice(3)))[0];
  if (highest) writeJson(watermarkPath, highest);
  const current = loadSession(dataDir)?.conversationId;
  cancelExecution(dataDir, conversationId);
  abortLocalProcesses(localScope(dataDir, conversationId));
  abortJobsForScope(jobScope(dataDir, conversationId));
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
  cancelExecution(dataDir, session.conversationId);
  abortLocalProcesses(localScope(dataDir, session.conversationId));
  abortJobsForScope(jobScope(dataDir, session.conversationId));
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
