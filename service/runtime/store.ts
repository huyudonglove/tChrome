import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Ledger, LogEvent, MemoryRecord, ObservationRecord, Session, Turn } from "../types.ts";
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
    toolQueue: [],
    toolIO: [],
    observation: [],
    windowChars: 0,
    compressAt: 200000,
    memoryIds: { turn: [], conversation: [], project: [] },
    contextSummary: null,
  };
}

export function loadLedger(dataDir: string, cvId: string): Ledger {
  return readJson(paths(dataDir, cvId).ledger, emptyLedger(cvId));
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
