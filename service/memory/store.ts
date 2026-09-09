import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Memories, MemoryIds, MemoryRecord } from "./types.ts";

const memoryDir = (dataDir: string, conversationId: string) => join(dataDir, "conversations", conversationId, "memory");
const projectDir = (dataDir: string) => join(dataDir, "memory", "project");
const jsonFiles = (dir: string) => existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".json")).sort() : [];
type StoredMemoryRecord = Omit<MemoryRecord, "layer"> & { layer: MemoryRecord["layer"] | "turn" };
const readStored = (path: string): StoredMemoryRecord => JSON.parse(readFileSync(path, "utf8"));
const read = (path: string): MemoryRecord => {
  const record = readStored(path);
  return { ...record, layer: record.layer === "turn" ? "conversation" : record.layer };
};
const chronological = (a: MemoryRecord, b: MemoryRecord) => a.createdAt.localeCompare(b.createdAt)
  || a.memoryId.localeCompare(b.memoryId, undefined, { numeric: true });

/** Merge legacy process memories into the conversation's persistent memory index. */
export function migrateConversationMemory(dataDir: string, conversationId: string, ids: MemoryIds & { turn?: string[] }): MemoryIds {
  if (!Object.hasOwn(ids, "turn")) return ids;
  const records = [...new Set([...ids.conversation, ...(ids.turn ?? [])])].map(memoryId => {
    const path = join(memoryDir(dataDir, conversationId), `${memoryId}.json`);
    const stored = readStored(path);
    const record: MemoryRecord = { ...stored, layer: stored.layer === "turn" ? "conversation" : stored.layer };
    if (stored.layer === "turn") {
      writeFileSync(`${path}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
      renameSync(`${path}.tmp`, path);
    }
    return record;
  }).sort(chronological);
  return { conversation: records.map(record => record.memoryId), project: [...ids.project] };
}

/** Copy legacy long-term records before any conversation can be deleted. */
export function migrateProjectMemories(dataDir: string): void {
  const marker = join(dataDir, "memory", "project-migration-v1.json");
  if (existsSync(marker)) return;
  const dir = projectDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const conversations = join(dataDir, "conversations");
  const ids = existsSync(conversations) ? readdirSync(conversations).filter(name => name.startsWith("cv_")).sort() : [];
  for (const conversationId of ids) {
    for (const file of jsonFiles(memoryDir(dataDir, conversationId))) {
      const record = read(join(memoryDir(dataDir, conversationId), file));
      if (record.layer !== "project") continue;
      const memoryId = `legacy_${conversationId}_${record.memoryId}`;
      const path = join(dir, `${memoryId}.json`);
      if (!existsSync(path)) writeFileSync(path, JSON.stringify({ ...record, memoryId, sourceConversationId: conversationId }, null, 2) + "\n");
    }
  }
  writeFileSync(`${marker}.tmp`, "{}\n");
  renameSync(`${marker}.tmp`, marker);
}

export function loadMemory(dataDir: string, conversationId: string, memoryId: string): MemoryRecord {
  const local = join(memoryDir(dataDir, conversationId), `${memoryId}.json`);
  if (existsSync(local)) return read(local);
  return read(join(projectDir(dataDir), `${memoryId}.json`));
}

export function saveMemory(dataDir: string, conversationId: string, record: MemoryRecord): void {
  if (record.layer === "project") migrateProjectMemories(dataDir);
  const dir = record.layer === "project" ? projectDir(dataDir) : memoryDir(dataDir, conversationId);
  mkdirSync(dir, { recursive: true });
  const stored = record.layer === "project" ? { ...record, sourceConversationId: conversationId } : record;
  writeFileSync(join(dir, `${record.memoryId}.json`), `${JSON.stringify(stored, null, 2)}\n`, record.layer === "project" ? { flag: "wx" } : {});
}

export function loadMemories(dataDir: string, conversationId: string, ids: MemoryIds): Memories {
  migrateProjectMemories(dataDir);
  const local = (names: string[]) => names.map(id => loadMemory(dataDir, conversationId, id));
  const project = jsonFiles(projectDir(dataDir)).map(file => read(join(projectDir(dataDir), file)))
    .sort(chronological);
  return { project, conversation: local(ids.conversation) };
}
