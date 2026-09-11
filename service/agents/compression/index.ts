import { randomUUID } from "node:crypto";
import type { Provider } from "../../types.ts";
import { requestTurnSummaries, type CompressionTurn, type TurnSummary } from "./protocol.ts";
import { commitArchive, loadIndex } from "../../context-archive/store.ts";
import type { CompressionModule, CompressionRecord, SourceRecord } from "../../context-archive/types.ts";

const REQUEST_CHARS = 60000;
type Input = {
  dataDir: string; conversationId: string; repoRoot: string; provider: Provider;
  module: CompressionModule; records: SourceRecord[]; isCancelled?: () => boolean; recompress?: boolean;
};
const running = new Set<string>();
const size = (turns: CompressionTurn[]) => JSON.stringify({ turns }).length;
function asTurn(content: unknown): CompressionTurn {
  if (!content || typeof content !== "object" || !("turnId" in content) || typeof content.turnId !== "string" || !content.turnId.trim()) throw new Error("Compression source missing turnId");
  return content as CompressionTurn;
}

/** Called only by the runtime's shared window-budget flow; index commit is all-or-none. */
export async function compressRecords(input: Input): Promise<void> {
  const lock = JSON.stringify([input.dataDir, input.conversationId, input.module]);
  if (running.has(lock)) throw new Error("Compression already running for this conversation");
  running.add(lock);
  try { await compress(input); } finally { running.delete(lock); }
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
  const request = async (turns: CompressionTurn[]) => {
    check();
    if (size(turns) > REQUEST_CHARS) throw new Error("Compression request exceeds chunk budget");
    const output = await requestTurnSummaries({ ...input, turns });
    check();
    return output;
  };
  // Oversized records are walked as typed field fragments: no clipping or nested JSON string.
  const summarizeLarge = async (turn: CompressionTurn): Promise<TurnSummary> => {
    const fragments: CompressionTurn[] = [];
    const visit = (value: unknown, path: (string | number)[]) => {
      const fragment = { turnId: turn.turnId, fragment: { path, value } };
      if (size([fragment]) <= REQUEST_CHARS) { fragments.push(fragment); return; }
      if (typeof value === "string") {
        for (let offset = 0; offset < value.length; offset += 8000) fragments.push({ turnId: turn.turnId, fragment: { path, offset, totalChars: value.length, value: value.slice(offset, offset + 8000) } });
      } else if (Array.isArray(value)) value.forEach((item, i) => visit(item, [...path, i]));
      else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => visit(item, [...path, key]));
      else throw new Error("Cannot split compression value");
    };
    visit(turn, []);
    let layer: TurnSummary[] = [];
    for (const fragment of fragments) layer.push((await request([fragment]))[0]!);
    while (layer.length > 1) {
      const next: TurnSummary[] = [];
      for (let offset = 0; offset < layer.length; offset += 4) next.push((await request([{ turnId: turn.turnId, summaries: layer.slice(offset, offset + 4) }]))[0]!);
      layer = next;
    }
    return layer[0]!;
  };
  const summarize = async (turns: CompressionTurn[]): Promise<TurnSummary[]> => {
    const output: TurnSummary[] = [];
    let batch: CompressionTurn[] = [];
    const flush = async () => { if (batch.length) output.push(...await request(batch)); batch = []; };
    for (const turn of turns) {
      if (size([turn]) > REQUEST_CHARS) { await flush(); output.push(await summarizeLarge(turn)); continue; }
      if (size([...batch, turn]) > REQUEST_CHARS) await flush();
      batch.push(turn);
    }
    await flush();
    return output;
  };
  const append = (summary: TurnSummary, level: number, sourceIds: string[]) => {
    const record: CompressionRecord = { id: `cmp_${randomUUID().replaceAll("-", "")}`, module: input.module, level, ...summary, sourceIds, createdAt: new Date().toISOString() };
    index.entries.push(record); added.push(record); return record;
  };
  const groups = new Map<string, SourceRecord[]>();
  for (const record of records) {
    const id = asTurn(record.content).turnId;
    groups.set(id, [...(groups.get(id) ?? []), record]);
  }
  const activeEntries = index.activeIds.map(id => index.entries.find(record => record.id === id)!);
  const previousByTurn = new Map([...groups.keys()].map(turnId => [turnId, activeEntries.filter(record => record.turnId === turnId)]));
  const turns = [...groups].map(([turnId, sources]) => {
    const previous = previousByTurn.get(turnId)!;
    if (!previous.length && sources.length === 1) return asTurn(sources[0]!.content);
    return { turnId, segments: sources.map(source => asTurn(source.content)), summaries: previous.map(({ tag, userRequest, actions, result }) => ({ tag, userRequest, actions, result })) };
  });
  for (const summary of await summarize(turns)) {
    const sources = groups.get(summary.turnId)!;
    const previous = previousByTurn.get(summary.turnId)!;
    const record = append(summary, previous.length ? Math.max(...previous.map(item => item.level)) + 1 : 1, [...previous.map(item => item.id), ...sources.map(source => source.id)]);
    if (previous.length) {
      const replaced = new Set(previous.map(item => item.id));
      index.activeIds = [...new Set(index.activeIds.map(id => replaced.has(id) ? record.id : id))];
    } else index.activeIds.push(record.id);
    sources.forEach(source => covered.add(source.id));
  }
  // No summary-size trigger here. Runtime explicitly requests one pass under its 200K gate.
  if (input.recompress) {
    const byId = new Map(index.entries.map(record => [record.id, record]));
    const grouped = new Map<string, CompressionRecord[]>();
    for (const id of index.activeIds) {
      const record = byId.get(id)!;
      grouped.set(record.turnId, [...(grouped.get(record.turnId) ?? []), record]);
    }
    const replacements = new Map<string, string>();
    for (const summary of await summarize([...grouped].map(([turnId, entries]) => ({ turnId, summaries: entries.map(({ tag, userRequest, actions, result }) => ({ tag, userRequest, actions, result })) })))) {
      const previous = grouped.get(summary.turnId)!;
      // Reject non-shrinking rollups without disturbing current heads.
      if (JSON.stringify(summary).length >= JSON.stringify(previous.map(({ turnId, tag, userRequest, actions, result }) => ({ turnId, tag, userRequest, actions, result }))).length - 2) continue;
      const record = append(summary, Math.max(...previous.map(entry => entry.level)) + 1, previous.map(entry => entry.id));
      previous.forEach(entry => replacements.set(entry.id, record.id));
    }
    index.activeIds = [...new Set(index.activeIds.map(id => replacements.get(id) ?? id))];
  }
  if (!added.length) return;
  index.coveredSourceIds = [...covered];
  check();
  commitArchive(input.dataDir, input.conversationId, index, records, added);
}
