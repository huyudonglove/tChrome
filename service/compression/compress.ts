import { randomUUID } from "node:crypto";
import type { Provider } from "../types.ts";
import { runJsonAgent } from "./agent.ts";
import { commitArchive, loadIndex } from "./store.ts";
import type { CompressionModule, CompressionRecord, SourceRecord } from "./types.ts";

const CHUNK_CHARS = 24000;
const SUMMARY_THRESHOLD = 20000;
type Summary = { tag: string; summary: string };
type Input = {
  dataDir: string; conversationId: string; repoRoot: string; provider: Provider;
  module: CompressionModule; records: SourceRecord[]; isCancelled?: () => boolean;
};
const running = new Set<string>();

/** Separate model requests and immutable archive writes; no original ledger mutation. */
export async function compressRecords(input: Input): Promise<void> {
  const lock = JSON.stringify([input.dataDir, input.conversationId, input.module]);
  if (running.has(lock)) throw new Error("Compression already running for this module");
  running.add(lock);
  try { await compress(input); } finally { running.delete(lock); }
}

async function compress(input: Input): Promise<void> {
  const check = () => { if (input.isCancelled?.()) throw new Error("Compression cancelled"); };
  check();
  const index = loadIndex(input.dataDir, input.conversationId, input.module);
  const covered = new Set(index.coveredSourceIds);
  const records: SourceRecord[] = [];
  const added: CompressionRecord[] = [];
  const originals = new Map<string, string>();
  for (const record of input.records) {
    if (covered.has(record.id)) continue;
    const serialized = JSON.stringify(record);
    if (originals.has(record.id)) {
      if (originals.get(record.id) !== serialized) throw new Error(`Conflicting source: ${record.id}`);
      continue;
    }
    originals.set(record.id, serialized);
    records.push(record);
  }
  const request = async (payload: unknown): Promise<Summary> => {
    check();
    if (JSON.stringify(payload).length > 60000) throw new Error("Compression request exceeds chunk budget");
    const output = await runJsonAgent({ ...input, promptNames: ["archive-role.md", "archive-output.md"], payload: { module: input.module, data: payload } });
    check();
    if (!output || typeof output !== "object") throw new Error("Invalid compression output");
    const value = output as Partial<Summary>;
    if (typeof value.tag !== "string" || !value.tag.trim() || value.tag.length > 500 || typeof value.summary !== "string" || !value.summary.trim() || value.summary.length > 8000) throw new Error("Invalid compression summary or tag");
    const summary = { tag: value.tag.trim(), summary: value.summary.trim() };
    if (JSON.stringify(summary).length > 12000) throw new Error("Compression output exceeds chunk budget");
    return summary;
  };
  const summarize = async (text: string): Promise<Summary> => {
    if (text.length <= CHUNK_CHARS) return request(text);
    // Preserve every character, including a single huge record, without clipping.
    let layer: Summary[] = [];
    for (let offset = 0; offset < text.length; offset += CHUNK_CHARS) {
      layer.push(await request({ part: offset / CHUNK_CHARS + 1, text: text.slice(offset, offset + CHUNK_CHARS) }));
    }
    while (layer.length > 1) {
      const next: Summary[] = [];
      // At most four validated summaries per consolidation request.
      for (let offset = 0; offset < layer.length; offset += 4) next.push(await request({ summaries: layer.slice(offset, offset + 4) }));
      layer = next;
    }
    return layer[0]!;
  };
  const append = (summary: Summary, level: number, sourceIds: string[]) => {
    const record: CompressionRecord = { id: `cmp_${randomUUID().replaceAll("-", "")}`, module: input.module, level, ...summary, sourceIds, createdAt: new Date().toISOString() };
    index.entries.push(record);
    added.push(record);
    return record;
  };
  const batches: SourceRecord[][] = [];
  let batch: SourceRecord[] = [], chars = 0;
  for (const record of records) {
    const size = JSON.stringify(record).length;
    if (batch.length && chars + size > CHUNK_CHARS) { batches.push(batch); batch = []; chars = 0; }
    batch.push(record); chars += size;
  }
  if (batch.length) batches.push(batch);
  for (const batch of batches) {
    const record = append(await summarize(JSON.stringify(batch)), 1, batch.map(item => item.id));
    index.activeIds.push(record.id);
    batch.forEach(item => covered.add(item.id));
  }
  // Only consecutive heads at the same level may be replaced, so source order stays stable.
  for (;;) {
    const byId = new Map(index.entries.map(record => [record.id, record]));
    const heads = index.activeIds.map(id => byId.get(id)!);
    let candidate: { start: number; entries: CompressionRecord[] } | null = null;
    for (let start = 0; start < heads.length;) {
      let end = start + 1;
      while (end < heads.length && heads[end]!.level === heads[start]!.level) end++;
      const entries = heads.slice(start, end);
      if (entries.length >= 2 && JSON.stringify(entries.map(({ tag, summary }) => ({ tag, summary }))).length >= SUMMARY_THRESHOLD) { candidate = { start, entries }; break; }
      start = end;
    }
    if (!candidate) break;
    const record = append(await summarize(JSON.stringify(candidate.entries.map(({ tag, summary }) => ({ tag, summary })))), candidate.entries[0]!.level + 1, candidate.entries.map(item => item.id));
    index.activeIds.splice(candidate.start, candidate.entries.length, record.id);
  }
  if (!added.length) return;
  index.coveredSourceIds = [...covered];
  check();
  commitArchive(input.dataDir, input.conversationId, index, records, added);
}
