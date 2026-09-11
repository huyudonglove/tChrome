import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, linkSync, rmSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { compressionModules, type CompressionModule, type CompressionIndex, type CompressionRecord, type SourceRecord } from "./types.ts";

function key(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid archive identifier");
  return value;
}
export function archiveDir(dataDir: string, conversationId: string, module: CompressionModule): string {
  if (!compressionModules.includes(module)) throw new Error("Invalid archive module");
  return join(dataDir, "conversations", key(conversationId), "compression", module);
}
function read<T>(path: string): T | null {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as T : null;
}
export function loadIndex(dataDir: string, cv: string, module: CompressionModule): CompressionIndex {
  return read<CompressionIndex>(join(archiveDir(dataDir, cv, module), "index.json")) ?? {
    version: 1, module, entries: [], activeIds: [], coveredSourceIds: [],
  };
}
export function readRecord(dataDir: string, cv: string, module: CompressionModule, id: string): CompressionRecord | null {
  const index = loadIndex(dataDir, cv, module);
  if (!index.entries.some(entry => entry.id === id)) return null;
  return read<CompressionRecord>(join(archiveDir(dataDir, cv, module), "records", `${key(id)}.json`));
}
export function readSource(dataDir: string, cv: string, module: CompressionModule, id: string): SourceRecord | null {
  if (!loadIndex(dataDir, cv, module).coveredSourceIds.includes(id)) return null;
  return read<SourceRecord>(join(archiveDir(dataDir, cv, module), "sources", `${key(id)}.json`));
}
export function resolveSources(dataDir: string, cv: string, module: CompressionModule, ids: string[]): SourceRecord[] {
  const index = loadIndex(dataDir, cv, module);
  const records = new Map(index.entries.map(record => [record.id, record]));
  const seen = new Set<string>();
  const visiting = new Set<string>();
  const output: SourceRecord[] = [];
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("Archive source cycle");
    if (seen.has(id)) return;
    const record = records.get(id);
    if (record) {
      visiting.add(id);
      record.sourceIds.forEach(visit);
      visiting.delete(id);
      seen.add(id);
      return;
    }
    const source = readSource(dataDir, cv, module, id);
    if (!source) throw new Error(`Archive source missing: ${id}`);
    seen.add(id);
    output.push(source);
  };
  ids.forEach(id => { if (!records.has(id)) throw new Error("Unknown archive record"); visit(id); });
  const order = new Map(index.coveredSourceIds.map((id, position) => [id, position]));
  const sequence = (source: SourceRecord) => {
    const value = source.content as { sequence?: { turn?: number; batch?: number } } | null;
    return value && typeof value === "object" ? value.sequence : undefined;
  };
  return output.sort((a, b) => {
    const left = sequence(a), right = sequence(b);
    if (typeof left?.turn === "number" && typeof right?.turn === "number") {
      return left.turn - right.turn || (left.batch ?? 0) - (right.batch ?? 0) || order.get(a.id)! - order.get(b.id)!;
    }
    return order.get(a.id)! - order.get(b.id)!;
  });
}
/** Index is the commit point; interrupted writes may leave unreferenced immutable files. */
export function commitArchive(dataDir: string, cv: string, index: CompressionIndex, sources: SourceRecord[], records: CompressionRecord[]): void {
  const root = archiveDir(dataDir, cv, index.module);
  const immutable = (folder: string, id: string, value: unknown) => {
    mkdirSync(join(root, folder), { recursive: true });
    const path = join(root, folder, `${key(id)}.json`);
    const text = JSON.stringify(value);
    const temp = join(root, folder, `.${key(id)}-${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, text, { flag: "wx" });
      try {
        linkSync(temp, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!isDeepStrictEqual(JSON.parse(readFileSync(path, "utf8")), JSON.parse(text))) throw new Error(`Archive source changed: ${id}`);
      }
    } finally {
      rmSync(temp, { force: true });
    }
  };
  sources.forEach(source => immutable("sources", source.id, source));
  records.forEach(record => immutable("records", record.id, record));
  mkdirSync(root, { recursive: true });
  const temp = join(root, `.index-${randomUUID()}.json`);
  try {
    writeFileSync(temp, JSON.stringify(index, null, 2), { flag: "wx" });
    renameSync(temp, join(root, "index.json"));
  } finally {
    rmSync(temp, { force: true });
  }
}
