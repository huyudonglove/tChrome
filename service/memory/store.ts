import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Memories, MemoryIds, MemoryRecord } from "./types.ts";

const memoryDir = (dataDir: string, conversationId: string) => join(dataDir, "conversations", conversationId, "memory");
const projectDir = (dataDir: string) => join(dataDir, "memory", "project");
const jsonFiles = (dir: string) => existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".json")).sort() : [];
const read = (path: string): MemoryRecord => JSON.parse(readFileSync(path, "utf8"));
const chronological = (a: MemoryRecord, b: MemoryRecord) => a.createdAt.localeCompare(b.createdAt)
  || a.memoryId.localeCompare(b.memoryId, undefined, { numeric: true });

export function loadMemory(dataDir: string, conversationId: string, memoryId: string): MemoryRecord {
  const local = join(memoryDir(dataDir, conversationId), `${memoryId}.json`);
  if (existsSync(local)) return read(local);
  return read(join(projectDir(dataDir), `${memoryId}.json`));
}

export function saveMemory(dataDir: string, conversationId: string, record: MemoryRecord): void {
  const dir = record.layer === "project" ? projectDir(dataDir) : memoryDir(dataDir, conversationId);
  mkdirSync(dir, { recursive: true });
  const stored = record.layer === "project" ? { ...record, sourceConversationId: conversationId } : record;
  writeFileSync(join(dir, `${record.memoryId}.json`), `${JSON.stringify(stored, null, 2)}\n`, record.layer === "project" ? { flag: "wx" } : {});
}

export function loadMemories(dataDir: string, conversationId: string, ids: MemoryIds): Memories {
  const local = (names: string[]) => names.map(id => loadMemory(dataDir, conversationId, id));
  const project = jsonFiles(projectDir(dataDir)).map(file => read(join(projectDir(dataDir), file)))
    .sort(chronological);
  return { project, conversation: local(ids.conversation) };
}
