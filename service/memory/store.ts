import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Memories, MemoryIds, MemoryRecord } from "./types.ts";

// Preserve the existing on-disk layout; extracting the capability needs no migration.
const memoryDir = (dataDir: string, conversationId: string) => join(dataDir, "conversations", conversationId, "memory");

export function loadMemory(dataDir: string, conversationId: string, memoryId: string): MemoryRecord {
  return JSON.parse(readFileSync(join(memoryDir(dataDir, conversationId), `${memoryId}.json`), "utf8")) as MemoryRecord;
}

export function saveMemory(dataDir: string, conversationId: string, record: MemoryRecord): void {
  const dir = memoryDir(dataDir, conversationId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${record.memoryId}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

export function loadMemories(dataDir: string, conversationId: string, ids: MemoryIds): Memories {
  const read = (names: string[]) => names.map(id => loadMemory(dataDir, conversationId, id));
  return { project: read(ids.project), conversation: read(ids.conversation), turn: read(ids.turn) };
}
