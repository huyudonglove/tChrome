import { allocateRecordId } from "../../runtime/ids.ts";
import { runtimeConfig } from "../../config/runtime.ts";
import type { LoopRecord, Provider } from "../../types.ts";
import { requestLoopFold, requestLoopSummaries } from "./protocol.ts";
import { commitArchive, loadIndex } from "../../context-archive/store.ts";
import type { CompressionModule, CompressionRecord, SourceRecord } from "../../context-archive/types.ts";

type Input = { dataDir: string; conversationId: string; repoRoot: string; provider: Provider; module: CompressionModule; records: SourceRecord[]; isCancelled?: () => boolean; onProgress?: (event: CompressProgress) => void };
export type CompressOutcome = { status: "completed" | "stopped" | "noop"; committedLoopIds: string[]; failedLoopIds?: string[]; totalLoops: number; windowChars?: { before: number | null; after: number | null } };
export type CompressProgress =
  | { type: "start"; total: number }
  | { type: "batch"; completed: number; total: number; loopIds: string[] }
  | { type: "fold"; merged: number; level: number; loopIds: number }
  | { type: "stopped"; completed: number; total: number; failedLoopIds?: string[] };
const running = new Map<string, { isCancelled?: () => boolean }>();
function asLoop(source: SourceRecord): LoopRecord {
  const loop = source.content as LoopRecord;
  if (!loop || loop.id !== source.id || !Array.isArray(loop.runtime)) throw new Error("Invalid compression loop source");
  return loop;
}
/** User inputs and interruptions start partitions. An unanchored span is split into two batches. */
export function partitionLoops(records: SourceRecord[]): SourceRecord[][] {
  const batches: SourceRecord[][] = [];
  let current: SourceRecord[] = [];
  let anchored = false;
  const flush = () => {
    if (!current.length) return;
    if (anchored || current.length === 1) batches.push(current);
    else { const middle = Math.ceil(current.length / 2); batches.push(current.slice(0, middle), current.slice(middle)); }
    current = [];
  };
  for (const record of records) {
    const boundary = asLoop(record).runtime.some(row => row.type === "userInput" || row.type === "interrupt");
    if (boundary) { flush(); anchored = true; }
    current.push(record);
  }
  flush();
  return batches;
}
export async function compressRecords(input: Input): Promise<CompressOutcome> {
  const lock = JSON.stringify([input.dataDir, input.conversationId, input.module]);
  const previous = running.get(lock);
  if (previous && !previous.isCancelled?.()) throw new Error("Compression already running for this conversation");
  const owner = { isCancelled: input.isCancelled };
  running.set(lock, owner);
  try { return await compress(input); } finally { if (running.get(lock) === owner) running.delete(lock); }
}
async function compress(input: Input): Promise<CompressOutcome> {
  const check = () => { if (input.isCancelled?.()) throw new Error("Compression cancelled"); };
  check();
  const index = loadIndex(input.dataDir, input.conversationId, input.module);
  const covered = new Set(index.coveredSourceIds);
  const unique = new Map<string, SourceRecord>();
  for (const source of input.records) {
    if (covered.has(source.id)) continue;
    asLoop(source);
    const prior = unique.get(source.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(source)) throw new Error(`Conflicting source: ${source.id}`);
    unique.set(source.id, source);
  }
  const batches = partitionLoops([...unique.values()]);
  const totalLoops = unique.size;
  const committedLoopIds: string[] = [];
  if (!batches.length) return { status: "noop", committedLoopIds, totalLoops };
  input.onProgress?.({ type: "start", total: batches.length });
  let completed = 0;
  for (const sources of batches) {
    check();
    const loopIds = sources.map(source => source.id);
    let summaries;
    try { summaries = await requestLoopSummaries({ ...input, loops: sources.map(asLoop) }); }
    catch (error) {
      if (input.isCancelled?.() || (error instanceof Error && /cancel/i.test(error.message))) throw error;
      input.onProgress?.({ type: "stopped", completed, total: batches.length, failedLoopIds: loopIds });
      return { status: "stopped", committedLoopIds, failedLoopIds: loopIds, totalLoops };
    }
    check();
    const records: CompressionRecord[] = summaries.map(summary => ({ ...summary, id: allocateRecordId(input.dataDir, input.conversationId, "sum"), module: input.module, level: 1, sourceIds: [...loopIds], createdAt: new Date().toISOString() }));
    index.entries.push(...records);
    index.activeIds.push(...records.map(record => record.id));
    loopIds.forEach(id => covered.add(id));
    index.coveredSourceIds = [...covered];
    commitArchive(input.dataDir, input.conversationId, index, sources, records);
    committedLoopIds.push(...loopIds);
    completed++;
    input.onProgress?.({ type: "batch", completed, total: batches.length, loopIds });
  }
  try { await foldActiveSummaries({ ...input, protectLoopId: committedLoopIds.at(-1) ?? null }); }
  catch (error) { if (input.isCancelled?.() || (error instanceof Error && /cancel/i.test(error.message))) throw error; }
  return { status: "completed", committedLoopIds, totalLoops };
}
/** Per-level gates, same-source L1 consolidation, then ascending L2 through configured maximum. */
export async function foldActiveSummaries(input: Input & { protectLoopId: string | null }): Promise<number> {
  const index = loadIndex(input.dataDir, input.conversationId, input.module);
  const entries = () => index.activeIds.map(id => index.entries.find(row => row.id === id)!);
  const eligible = (row: CompressionRecord) => !input.protectLoopId || !row.loopIds.includes(input.protectLoopId);
  const byTime = (a: CompressionRecord, b: CompressionRecord) => a.createdAt.localeCompare(b.createdAt);
  let merged = 0;
  const fold = async (rows: CompressionRecord[], level: number) => {
    if (rows.length < 2) return;
    if (input.isCancelled?.()) throw new Error("Compression cancelled");
    const sourceOrder = new Map(index.coveredSourceIds.map((id, position) => [id, position]));
    const loopIds = [...new Set(rows.flatMap(row => row.loopIds))].sort((a, b) => (sourceOrder.get(a) ?? Infinity) - (sourceOrder.get(b) ?? Infinity));
    const summary = await requestLoopFold({ ...input, level, loopIds, rows });
    if (input.isCancelled?.()) throw new Error("Compression cancelled");
    const record: CompressionRecord = { ...summary, id: allocateRecordId(input.dataDir, input.conversationId, "sum"), module: input.module, level, sourceIds: rows.map(row => row.id), createdAt: new Date().toISOString() };
    index.entries.push(record);
    const replaced = new Set(record.sourceIds);
    index.activeIds = [...new Set(index.activeIds.flatMap(id => replaced.has(id) ? [record.id] : [id]))];
    commitArchive(input.dataDir, input.conversationId, index, [], [record]);
    merged++;
    input.onProgress?.({ type: "fold", merged, level, loopIds: loopIds.length });
  };
  const threshold = runtimeConfig.context.summaryFoldMinRows;
  if (entries().filter(row => row.level === 1).length > threshold) {
    const groups = new Map<string, CompressionRecord[]>();
    for (const row of entries().filter(row => row.level === 1 && row.loopIds.length === 1 && eligible(row))) {
      const key = JSON.stringify(row.loopIds);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const rows of groups.values()) if (rows.length > 1) await fold(rows.sort(byTime), 1);
  }
  for (let level = 1; level < runtimeConfig.context.foldMaxLevel; level++) {
    const rows = entries().filter(row => row.level === level && eligible(row)).sort(byTime);
    if (rows.length <= threshold) continue;
    const chunk = level === 1 ? runtimeConfig.context.foldL1ToL2Chunk : runtimeConfig.context.foldHigherChunk;
    const candidates = rows.slice(0, -1);
    for (let start = 0; start < candidates.length; start += chunk) await fold(candidates.slice(start, start + chunk), level + 1);
  }
  return merged;
}
