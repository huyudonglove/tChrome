import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Ledger, LogEvent, ChatMessage, Session, ToolIOItem, Turn } from "../types.ts";
import type { BlockIndex } from "../evidence/index.ts";
import { runtimeConfig } from "../config/runtime.ts";
import { idPrefix, nextId, nowIso } from "./ids.ts";
import { appendAsset, textSummary } from "../assets/catalog.ts";
import { abortLocalProcesses } from "../tools/local-process.ts";
import { abortJobsForScope, jobScope } from "../tools/job-registry.ts";
import { localScope } from "../tools/local-tools.ts";
import { appendRuntime } from "./loop-records.ts";
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
    // toolio logs live in their own subdirectory so the conversation root stays flat-free:
    // toolio/toolio.jsonl (active) + toolio/toolio.NN.jsonl (rotation archives).
    toolioDir: join(conv, "toolio"),
    toolio: join(conv, "toolio", "toolio.jsonl"),
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
    schemaVersion: 3,
    loops: [],
    conversationId,
    createdAt: t,
    updatedAt: t,
    status: "idle",
    active: null,
    pendingAsk: null,
    turnIds: [],
    loadedToolIds: [],
    loadedSkillIds: [],
    userInputHistory: [],
    reflectHistory: [],
    tasks: [],
    taskHistory: [],
    activeTaskId: null,
    activeTaskItemId: null,
    toolQueue: [],
    liveTools: [],
    toolIO: [],
    lastAction: null,
    boundSeq: 0,
    contextTab: null,
    queryHistory: [],
    windowChars: 0,
    compressAt: runtimeConfig.context.compressAtChars,
    memoryIds: { conversation: [], project: [] },
  };
}


export function loadLedger(dataDir: string, cvId: string): Ledger {
  const raw = readJson<Partial<Ledger>>(paths(dataDir, cvId).ledger, emptyLedger(cvId));
  if (raw.schemaVersion !== 3 || !Array.isArray(raw.loops)) throw new Error("unsupported_conversation_schema: 请创建新会话，旧数据不支持读取");
  const ledger = raw as Ledger;
  const cache = toolRowCache(dataDir, cvId);
  ledger.toolIO = cache.rows;
  return ledger;
}

export function saveLedger(dataDir: string, ledger: Ledger): void {
  ledger.updatedAt = nowIso();
  const cvId = ledger.conversationId;
  persistToolRows(dataDir, cvId, ledger.toolIO ?? []);
  // toolIO lives in the append-only toolio.jsonl; ledger.json only carries conversation state.
  const { toolIO: _toolIO, ...state } = ledger;
  writeJson(paths(dataDir, cvId).ledger, state);
}

/** Ensure a conversation has an active standalone Task so non-exempt tools can run (tests / fixtures). */
export function primeActiveTask(dataDir: string): void {
  const session = ensureSession(dataDir);
  const ledger = loadLedger(dataDir, session.conversationId);
  if (ledger.activeTaskId) return;
  const now = nowIso();
  const id = "task_01";
  if (!ledger.tasks.some((row) => row.id === id)) {
    ledger.tasks.push({
      id,
      status: "active",
      items: [],
      createdAt: now,
      updatedAt: now,
    });
  }
  ledger.activeTaskId = id;
  ledger.activeTaskItemId = null;
  saveLedger(dataDir, ledger);
}

export function loadTurn(dataDir: string, cvId: string, turnId: string): Turn {
  const turn = JSON.parse(readFileSync(join(paths(dataDir, cvId).turns, `${turnId}.json`), "utf8")) as Turn;
  return turn;
}

export function saveTurn(dataDir: string, turn: Turn): void {
  writeJson(join(paths(dataDir, turn.conversationId).turns, `${turn.turnId}.json`), turn);
}


export function saveFullReturn(dataDir: string, cvId: string, callId: string, full: string): void {
  const dir = paths(dataDir, cvId).returns;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${callId}.txt`);
  writeFileSync(path, full);
  appendAsset(dataDir, cvId, {
    name: `${callId}.txt`,
    kind: "text",
    bytes: Buffer.byteLength(full, "utf8"),
    summary: textSummary(full),
    source: { callId },
    path: `returns/${callId}.txt`,
  });
}

/** 完整块树与解码内容快照一起保存；块范围始终指向当次返回。 */
export function saveReturnBlockIndex(dataDir: string, cvId: string, callId: string, index: BlockIndex): string {
  const dir = paths(dataDir, cvId).returns;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${callId}.index.json`);
  writeFileSync(path, JSON.stringify(index));
  return path;
}

export function loadReturnBlockIndex(dataDir: string, cvId: string, callId: string): BlockIndex | null {
  const path = join(paths(dataDir, cvId).returns, `${callId}.index.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as BlockIndex;
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

/** Shared cap for the append-only events.jsonl conversation log. */
const LOG_ROTATE_BYTES = 3 * 1024 * 1024;

/**
 * Rotate the active log when size + incoming would exceed 3MB.
 * Archives as `<stem>.NN.<ext>` (events.01.jsonl); active path stays the write target.
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

/**
 * toolIO rows live in the append-only toolio.jsonl (one JSON object per line) instead of
 * ledger.json, so ledger.json stops growing with every tool call. Two line kinds:
 * `{ k: "row", row }` appends a new call, `{ k: "amend", callId, return }` replaces the return
 * of an already appended row (last-wins on read) — that covers the paths that rewrite a row's
 * return after the fact (saveFullReturn on tool failure, stripping nudge markers at assembly).
 */
type ToolIoLine = { k: "row"; row: ToolIOItem } | { k: "amend"; callId: string; return: ToolIOItem["return"] };

interface ToolRowCache {
  rows: ToolIOItem[];
  byCallId: Map<string, ToolIOItem>;
  persistedCount: number;
  persistedReturn: Map<string, string>;
}

const toolRowCaches = new Map<string, ToolRowCache>();

/**
 * Change detector for a row's return. Length alone is not enough: the rewrite
 * paths (full return restored after a failure, nudge markers stripped) can land
 * on the same character count, so fold in a 32-bit FNV hash of the text. Still
 * ~20x cheaper than re-serializing every row.
 */
const returnSignature = (row: ToolIOItem): string => {
  const text = row.return.text ?? "";
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${row.return.stage}|${row.return.totalChars ?? 0}|${text.length}|${hash.toString(36)}`;
};

export function loadToolRows(dataDir: string, cvId: string): ToolIOItem[] {
  return toolRowCache(dataDir, cvId).rows;
}

function toolRowCache(dataDir: string, cvId: string): ToolRowCache {
  const key = `${dataDir}::${cvId}`;
  const hit = toolRowCaches.get(key);
  if (hit) return hit;
  const { conv, toolioDir, toolio: active } = paths(dataDir, cvId);
  // Rotation archives may sit in the toolio/ subdirectory or, for conversations written
  // before that existed, flat in the conversation root. Merge both by NN index: the
  // subdirectory copy wins when the same index shows up twice.
  const byIndex = new Map<string, { index: number; path: string }>();
  for (const dir of [conv, toolioDir]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const matched = /^toolio\.(\d+)\.jsonl$/.exec(name);
      const rotation = matched?.[1];
      if (!rotation) continue;
      byIndex.set(rotation, { index: Number(rotation), path: join(dir, name) });
    }
  }
  const archives = [...byIndex.values()].sort((a, b) => a.index - b.index).map((entry) => entry.path);
  const cache: ToolRowCache = { rows: [], byCallId: new Map(), persistedCount: 0, persistedReturn: new Map() };
  for (const path of [...archives, active]) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      let entry: ToolIoLine;
      try {
        entry = JSON.parse(line) as ToolIoLine;
      } catch {
        continue; // a torn last line from a hard kill; skip it
      }
      if (entry.k === "row") {
        cache.rows.push(entry.row);
        cache.byCallId.set(entry.row.callId, entry.row);
        cache.persistedReturn.set(entry.row.callId, returnSignature(entry.row));
      } else if (entry.k === "amend") {
        const row = cache.byCallId.get(entry.callId);
        if (!row) continue;
        row.return = entry.return;
        cache.persistedReturn.set(entry.callId, returnSignature(row));
      }
    }
  }
  cache.persistedCount = cache.rows.length;
  toolRowCaches.set(key, cache);
  return cache;
}

/** Flush rows that are not on disk yet, then one amend line per row whose return changed. */
function persistToolRows(dataDir: string, cvId: string, rows: ToolIOItem[]): void {
  const cache = toolRowCache(dataDir, cvId);
  const path = paths(dataDir, cvId).toolio;
  const payloads: string[] = [];
  if (rows !== cache.rows) {
    // loadLedger hands out cache.rows as the live reference, so callers normally mutate that array;
    // a ledger built independently (tests, tooling) is adopted into the cache before flushing.
    for (const row of rows) {
      const known = cache.byCallId.get(row.callId);
      if (!known) cache.byCallId.set(row.callId, row);
      else if (known !== row) Object.assign(known, row);
    }
    for (const row of rows) if (!cache.rows.includes(row)) cache.rows.push(row);
  }
  for (const row of cache.rows.slice(cache.persistedCount)) {
    payloads.push(`${JSON.stringify({ k: "row", row } satisfies ToolIoLine)}\n`);
    cache.byCallId.set(row.callId, row);
    cache.persistedReturn.set(row.callId, returnSignature(row));
  }
  for (const row of cache.rows) {
    const signature = returnSignature(row);
    if (cache.persistedReturn.get(row.callId) === signature) continue;
    payloads.push(`${JSON.stringify({ k: "amend", callId: row.callId, return: row.return } satisfies ToolIoLine)}\n`);
    cache.persistedReturn.set(row.callId, signature);
  }
  cache.persistedCount = Math.max(cache.persistedCount, rows.length);
  if (payloads.length === 0) return;
  const payload = payloads.join("");
  mkdirSync(dirname(path), { recursive: true });
  rotateLogIfNeeded(path, Buffer.byteLength(payload, "utf8"));
  if (existsSync(path)) appendFileSync(path, payload);
  else writeFileSync(path, payload);
}

export function sessionView(dataDir: string, cvId: string): SessionView {
  const ledger = loadLedger(dataDir, cvId);
  return projectSessionView({
    ledger,
    events: loadEvents(dataDir, cvId),
    turns: ledger.turnIds.map((turnId) => loadTurn(dataDir, cvId, turnId)),
  });
}

// `conversationId` lets each panel read its own conversation; when omitted the
// global pointer stays the fallback so single-panel behaviour is unchanged.
export function currentSessionView(dataDir: string, conversationId?: string | null): SessionView {
  const requested = conversationId ?? null;
  if (requested) {
    if (!listConversationIds(dataDir).includes(requested)) return currentSessionView(dataDir);
    return sessionView(dataDir, requested);
  }
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

/**
 * 复位被硬杀留下的 running 会话。
 *
 * 进程遇 SIGKILL / 崩溃 / 断电时来不及走 stopTurn，ledger.status 会停在 running；
 * 之后 POST /turn 一见 running 就返回 busy，这个会话再也开不了新轮。
 * 服务刚启动时不可能有轮次在跑，所以残留的 running 一定是脏数据：把当轮标
 * failed / interrupted(service)，会话退回 paused。返回被复位的会话 ID 列表。
 */
/**
 * 复位单个残留 running 会话：把当轮标 failed / interrupted(service)，会话退回 paused。
 * detail 由调用方给出，因为「服务启动时清扫」与「运行期发现该会话已无在跑执行」语境不同。
 * 返回是否真的发生了复位。
 */
export function recoverStaleRun(dataDir: string, conversationId: string, detail = "服务重启前该轮未正常收尾"): boolean {
  const ledger = loadLedger(dataDir, conversationId);
  if (ledger.status !== "running") return false;
  const turnId = ledger.active?.turnId;
  if (turnId && existsSync(join(paths(dataDir, conversationId).turns, `${turnId}.json`))) {
    const turn = loadTurn(dataDir, conversationId, turnId);
    turn.status = "failed";
    turn.completedAt = nowIso();
    turn.stopReason = { kind: "interrupted", initiatedBy: "service", detail };
    saveTurn(dataDir, turn);
  }
  const lastLoop = ledger.loops.at(-1);
  if (lastLoop?.sentAt && !lastLoop.completedAt) lastLoop.completedAt = nowIso();
  appendRuntime(dataDir, ledger, turnId ?? "", "interrupt", { initiatedBy: "service", detail });
  ledger.status = "paused";
  ledger.active = null;
  ledger.pendingAsk = null;
  saveLedger(dataDir, ledger);
  return true;
}

export function recoverStaleRuns(dataDir: string): string[] {
  const recovered: string[] = [];
  for (const conversationId of listConversationIds(dataDir)) {
    if (recoverStaleRun(dataDir, conversationId)) recovered.push(conversationId);
  }
  return recovered;
}

export function stopTurn(dataDir: string, targetConversationId?: string | null, initiatedBy: "user" | "service" = "user"): SessionView {
  // Stop the caller's conversation; the global pointer stays the fallback.
  const session = { conversationId: targetConversationId || loadSession(dataDir)?.conversationId };
  if (!session.conversationId) return currentSessionView(dataDir);
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
    turn.stopReason = { kind: "interrupted", initiatedBy };
    saveTurn(dataDir, turn);
    appendEvent(dataDir, session.conversationId, { kind: "turn-stop-reason", turnId, data: { stopReason: turn.stopReason } });
  }
  const lastLoop = ledger.loops.at(-1);
  if (lastLoop?.sentAt && !lastLoop.completedAt) lastLoop.completedAt = nowIso();
  appendRuntime(dataDir, ledger, turnId ?? "", "interrupt", { initiatedBy });
  ledger.status = "paused";
  ledger.active = null;
  ledger.pendingAsk = null;
  ledger.toolQueue = [];
  ledger.liveTools = [];
  saveLedger(dataDir, ledger);
  appendEvent(dataDir, session.conversationId, { kind: "session", data: { conversationId: session.conversationId, action: "stop" } });
  return sessionView(dataDir, session.conversationId);
}
