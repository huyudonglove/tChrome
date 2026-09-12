import { allocateRecordId } from "../../runtime/ids.ts";
import type { Provider } from "../../types.ts";
import { requestTurnSummaries, type CompressionTurn, type TurnSummary } from "./protocol.ts";
import { commitArchive, loadIndex } from "../../context-archive/store.ts";
import type { CompressionModule, CompressionRecord, SourceRecord } from "../../context-archive/types.ts";

type Input = {
  dataDir: string; conversationId: string; repoRoot: string; provider: Provider;
  module: CompressionModule; records: SourceRecord[]; isCancelled?: () => boolean; recompress?: boolean;
};
const running = new Map<string, { isCancelled?: () => boolean }>();
function asTurn(content: unknown): CompressionTurn {
  if (!content || typeof content !== "object" || !("turnId" in content) || typeof content.turnId !== "string" || !content.turnId.trim()) throw new Error("Compression source missing turnId");
  return content as CompressionTurn;
}

/** Called only by the runtime's shared window-budget flow; index commit is all-or-none. */
export async function compressRecords(input: Input): Promise<void> {
  const lock = JSON.stringify([input.dataDir, input.conversationId, input.module]);
  const previous = running.get(lock);
  if (previous && !previous.isCancelled?.()) throw new Error("Compression already running for this conversation");
  const owner = { isCancelled: input.isCancelled };
  running.set(lock, owner);
  try { await compress(input); }
  finally { if (running.get(lock) === owner) running.delete(lock); }
}

async function compress(input: Input): Promise<void> {
  const check = () => { if (input.isCancelled?.()) throw new Error("Compression cancelled"); };
  check();
  const index = loadIndex(input.dataDir, input.conversationId, input.module);
  const covered = new Set(index.coveredSourceIds);
  const unique = new Map<string, SourceRecord>();
  for (const record of input.records) {
    if (covered.has(record.id)) continue;
    asTurn(record.content);
    const prior = unique.get(record.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(record)) throw new Error(`Conflicting source: ${record.id}`);
    unique.set(record.id, record);
  }
  const records = [...unique.values()];
  const added: CompressionRecord[] = [];
  const append = (summary: TurnSummary, level: number, sourceIds: string[]) => {
    const record: CompressionRecord = { id: allocateRecordId(input.dataDir, input.conversationId, "sum"), module: input.module, level, ...summary, sourceIds, createdAt: new Date().toISOString() };
    index.entries.push(record); added.push(record); return record;
  };
  const groups = new Map<string, SourceRecord[]>();
  for (const record of records) {
    const id = asTurn(record.content).turnId;
    groups.set(id, [...(groups.get(id) ?? []), record]);
  }
  const activeEntries = index.activeIds.map(id => index.entries.find(record => record.id === id)!);
  if (input.recompress) {
    for (const entry of activeEntries) if (!groups.has(entry.turnId)) groups.set(entry.turnId, []);
  }
  const previousByTurn = new Map([...groups.keys()].map(turnId => [turnId, activeEntries.filter(record => record.turnId === turnId)]));
  const turns = [...groups].map(([turnId, sources]) => {
    const previous = previousByTurn.get(turnId)!;
    if (!previous.length && sources.length === 1) return asTurn(sources[0]!.content);
    return { turnId, segments: sources.map(source => asTurn(source.content)), summaries: previous.map(({ tag, userRequest, actions, result }) => ({ tag, userRequest, actions, result })) };
  });
  if (!turns.length) return;
  check();
  const summaries = await requestTurnSummaries({ ...input, turns });
  check();
  for (const summary of summaries) {
    const sources = groups.get(summary.turnId)!;
    const previous = previousByTurn.get(summary.turnId)!;
    // A summary-only pass must shrink; new source coverage is committed with its summary.
    if (!sources.length && JSON.stringify(summary).length >= JSON.stringify(previous.map(({ turnId, tag, userRequest, actions, result }) => ({ turnId, tag, userRequest, actions, result }))).length - 2) continue;
    const record = append(summary, previous.length ? Math.max(...previous.map(item => item.level)) + 1 : 1, [...previous.map(item => item.id), ...sources.map(source => source.id)]);
    if (previous.length) {
      const replaced = new Set(previous.map(item => item.id));
      index.activeIds = [...new Set(index.activeIds.map(id => replaced.has(id) ? record.id : id))];
    } else index.activeIds.push(record.id);
    sources.forEach(source => covered.add(source.id));
  }
  if (!added.length) return;
  index.coveredSourceIds = [...covered];
  check();
  commitArchive(input.dataDir, input.conversationId, index, records, added);
}
