import { mkdirSync, readFileSync, writeFileSync, linkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { loadMemory } from "../memory/store.ts";

export type ContextRecordKind = "userInput" | "goal" | "pageObservation";
const kinds = new Set<string>(["userInput", "goal", "pageObservation"]);
const safeId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id);
const recordDirectory = (dataDir: string, conversationId: string, kind: ContextRecordKind) =>
  join(dataDir, "conversations", conversationId, "context-records", kind);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Publish a complete immutable source record before the context window references it. */
export function saveContextRecord<T extends { id: string }>(dataDir: string, conversationId: string, kind: ContextRecordKind, record: T): void {
  if (!safeId(conversationId) || !safeId(record.id) || !kinds.has(kind)) throw new Error("Invalid context record identity");
  const dir = recordDirectory(dataDir, conversationId, kind);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${record.id}.json`);
  const text = `${JSON.stringify(record, null, 2)}\n`;
  const temporary = join(dir, `.${record.id}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text, { flag: "wx" });
    try {
      // Hard linking publishes atomically and cannot replace an existing ID.
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!isDeepStrictEqual(JSON.parse(readFileSync(path, "utf8")), JSON.parse(text))) {
        throw new Error(`Context record ${kind}/${record.id} is immutable`);
      }
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Read sources independently of the live context window; memory uses its existing store. */
export function loadContextRecord(dataDir: string, conversationId: string, kind: ContextRecordKind | "memory", id: string): string | null {
  if (!safeId(conversationId) || !safeId(id) || (!kinds.has(kind) && kind !== "memory")) return null;
  try {
    if (kind === "memory") return `${JSON.stringify(loadMemory(dataDir, conversationId, id), null, 2)}\n`;
    return readFileSync(join(recordDirectory(dataDir, conversationId, kind), `${id}.json`), "utf8");
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
