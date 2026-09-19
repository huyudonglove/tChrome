import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Memories, MemoryIds, MemoryRecord } from "./types.ts";

const memoryDir = (dataDir: string, conversationId: string) => join(dataDir, "conversations", conversationId, "memory");
const projectDir = (dataDir: string) => join(dataDir, "memory", "project");
const jsonFiles = (dir: string) => existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".json")).sort() : [];
const read = (path: string): MemoryRecord => JSON.parse(readFileSync(path, "utf8"));
const chronological = (a: MemoryRecord, b: MemoryRecord) => a.createdAt.localeCompare(b.createdAt)
  || a.memoryId.localeCompare(b.memoryId, { numeric: true });

export function loadMemory(dataDir: string, conversationId: string, memoryId: string): MemoryRecord {
  const local = join(memoryDir(dataDir, conversationId), `${memoryId}.json`);
  if (existsSync(local)) return read(local);
  return read(join(projectDir(dataDir), `${memoryId}.json`));
}

export function saveMemory(dataDir: string, conversationId: string, record: MemoryRecord, options: { overwrite?: boolean } = {}): void {
  const dir = record.layer === "project" ? projectDir(dataDir) : memoryDir(dataDir, conversationId);
  mkdirSync(dir, { recursive: true });
  const stored = record.layer === "project" ? { ...record, sourceConversationId: conversationId } : record;
  const exclusive = record.layer === "project" && options.overwrite !== true;
  writeFileSync(join(dir, `${record.memoryId}.json`), `${JSON.stringify(stored, null, 2)}\n`, exclusive ? { flag: "wx" } : {});
}

export function updateMemory(dataDir: string, conversationId: string, memoryId: string, text: string): MemoryRecord {
  const existing = loadMemory(dataDir, conversationId, memoryId);
  const record: MemoryRecord = { ...existing, memoryId, layer: existing.layer, text };
  saveMemory(dataDir, conversationId, record, { overwrite: true });
  return record;
}

export function deleteMemory(dataDir: string, conversationId: string, memoryId: string): { layer: MemoryRecord["layer"]; existed: boolean } {
  const local = join(memoryDir(dataDir, conversationId), `${memoryId}.json`);
  const project = join(projectDir(dataDir), `${memoryId}.json`);
  let layer: MemoryRecord["layer"] = memoryId.startsWith("lm_") ? "project" : "conversation";
  let existed = false;
  if (existsSync(local)) { unlinkSync(local); layer = "conversation"; existed = true; }
  if (existsSync(project)) { unlinkSync(project); layer = "project"; existed = true; }
  return { layer, existed };
}

export function loadMemories(dataDir: string, conversationId: string, ids: MemoryIds): Memories {
  const local = (names: string[]) => names.flatMap(id => {
    try { return [loadMemory(dataDir, conversationId, id)]; } catch { return []; }
  });
  const project = jsonFiles(projectDir(dataDir)).map(file => read(join(projectDir(dataDir), file)))
    .sort(chronological);
  return { project, conversation: local(ids.conversation) };
}
