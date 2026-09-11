import { createHash } from "node:crypto";
import type { Provider } from "../../types.ts";
import { requestMatches, type QueryCandidate } from "./protocol.ts";
import { loadIndex, resolveSources } from "../../context-archive/store.ts";
import { queryModules, type QueryRequest, type QueryResult } from "./types.ts";
export type { QueryRequest, QueryResult, QueryModule } from "./types.ts";

type QueryInput = QueryRequest & { dataDir: string; conversationId: string; repoRoot: string; provider: Provider; isCancelled?: () => boolean };
type RecordValue = Record<string, unknown>;
const BATCH_CHARS = 24000, RETURN_CHARS = 2000, MAX_BATCHES = 100;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function identity(record: RecordValue): RecordValue {
  return Object.fromEntries(Object.entries(record).filter(([key]) => ["id", "turnId", "callId", "memoryId", "queryId", "sumId", "batchId", "sourceCallId"].includes(key)));
}
function fragment(record: RecordValue, text: string, offset: number, length: number): RecordValue {
  return { ...identity(record), fragment: { offset, totalChars: text.length, text: text.slice(offset, offset + length) } };
}
function batches(records: RecordValue[]): QueryCandidate[][] {
  const chunks: QueryCandidate[][] = []; let chunk: QueryCandidate[] = [];
  const append = (record: RecordValue) => {
    const item = { turnId: record.turnId as string, records: [record] };
    if (JSON.stringify([item]).length > BATCH_CHARS) throw new Error("候选记录身份字段过长。");
    const previous = chunk.find(candidate => candidate.turnId === item.turnId);
    const merged = previous
      ? chunk.map(candidate => candidate === previous ? { ...candidate, records: [...candidate.records, record] } : candidate)
      : [...chunk, item];
    if (JSON.stringify(merged).length > BATCH_CHARS) { chunks.push(chunk); chunk = [item]; }
    else chunk = merged;
  };
  for (const record of records) {
    const raw = JSON.stringify(record);
    if (JSON.stringify([{turnId:record.turnId,records:[record]}]).length <= BATCH_CHARS) append(record);
    else for (let offset = 0; offset < raw.length; offset += 4000) append(fragment(record, raw, offset, 4000));
  }
  if (chunk.length) chunks.push(chunk);
  if (chunks.length > MAX_BATCHES) throw new Error("候选内容超过单次查询批次上限，请缩小摘要或模块范围；未执行不完整检索。");
  return chunks;
}
/** Only traverse the requested summary's immutable source graph; retrieval never writes archive state. */
export async function queryContext(input: QueryInput): Promise<QueryResult> {
  const base = { sumId: input.sumId, module: input.module, intent: input.intent, records: [] };
  const cancelled = (): QueryResult => ({ ...base, ok: false, status: "cancelled", detail: "查询已取消。" });
  try {
    if (!queryModules.includes(input.module) || typeof input.sumId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(input.sumId)
      || typeof input.intent !== "string" || !input.intent.trim() || input.intent.length > 4000
      || (input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.length > 100000))) throw new Error("查询参数无效。");
    if (input.isCancelled?.()) return cancelled();
    const index = loadIndex(input.dataDir, input.conversationId, "conversationHistory");
    const byId = new Map(index.entries.map(entry => [entry.id, entry]));
    if (!byId.has(input.sumId)) throw new Error("sumId 不属于本会话的归档。");
    const sources = resolveSources(input.dataDir, input.conversationId, "conversationHistory", [input.sumId]);
    const records: RecordValue[] = [];
    const seen = new Set<string>();
    const add = (value: unknown, turnId: string) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("归档模块记录格式无效。");
      const original = value as RecordValue;
      if (original.turnId !== undefined && original.turnId !== turnId) throw new Error("归档记录 turnId 与来源轮次不一致。");
      const record = { ...original, turnId };
      const key = JSON.stringify(record);
      if (!seen.has(key)) { seen.add(key); records.push(record); }
    };
    if (input.module === "summaries") {
      const visited = new Set<string>();
      const visit = (id: string) => {
        if (visited.has(id)) return; visited.add(id);
        const entry = byId.get(id); if (!entry) return;
        const { id: sumId, ...fields } = entry;
        add({ sumId, ...fields }, entry.turnId);
        entry.sourceIds.forEach(visit);
      };
      visit(input.sumId);
    } else for (const source of sources) {
      const turn = source.content as RecordValue;
      if (!turn || typeof turn.turnId !== "string") throw new Error("归档缺少来源 turnId。");
      const values = turn[input.module];
      if (values == null) continue;
      for (const value of Array.isArray(values) ? values : [values]) add(value, turn.turnId);
    }
    const fingerprint = hash([input.conversationId,input.sumId,input.module,input.intent,records]);
    let selected: string[], position = 0, offset = 0;
    const allowed = new Set(records.map(record => record.turnId as string));
    if (input.cursor !== undefined) {
      const value = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
      if (value.fingerprint !== fingerprint || !Array.isArray(value.turnIds) || !value.turnIds.length || value.turnIds.some((id: unknown) => typeof id !== "string" || !allowed.has(id))
        || !Number.isSafeInteger(value.position) || value.position < 0 || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error("续查游标无效或不属于本次查询。");
      selected = [...new Set<string>(value.turnIds)]; position = value.position; offset = value.offset;
    } else {
      const matched = new Set<string>();
      for (const candidates of batches(records)) {
        if (input.isCancelled?.()) return cancelled();
        const turnIds = await requestMatches({ provider:input.provider,repoRoot:input.repoRoot,
          request:{sumId:input.sumId,module:input.module,intent:input.intent},candidates });
        if (input.isCancelled?.()) return cancelled();
        turnIds.forEach(id => matched.add(id));
      }
      selected = [...matched];
    }
    if (!selected.length) return { ...base, ok: true, status:"not_found",detail:"指定摘要来源中没有匹配的模块记录。" };
    const matches = records.filter(record => selected.includes(record.turnId as string));
    if (position >= matches.length || offset >= JSON.stringify(matches[position]).length) throw new Error("续查位置超出记录范围。");
    const output: RecordValue[] = [];
    while (position < matches.length) {
      const record = matches[position]!, raw = JSON.stringify(record);
      if (!offset && JSON.stringify([...output,record]).length <= RETURN_CHARS) { output.push(record); position++; continue; }
      if (output.length) break;
      let low = 0, high = raw.length - offset;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (JSON.stringify([fragment(record,raw,offset,middle)]).length <= RETURN_CHARS) low = middle; else high = middle - 1;
      }
      if (!low) throw new Error("记录身份字段超过查询返回预算。");
      output.push(fragment(record,raw,offset,low)); offset += low;
      if (offset === raw.length) { offset = 0; position++; }
      break;
    }
    if (input.isCancelled?.()) return cancelled();
    const partial = position < matches.length;
    return { ...base,ok:true,status:partial ? "partial" : "complete",records:output,
      ...(partial ? {nextCursor:Buffer.from(JSON.stringify({fingerprint,turnIds:selected,position,offset})).toString("base64url")} : {}),
      detail:partial ? "历史原文未全部返回；保持查询条件，用 nextCursor 继续。fragment 是原记录 JSON 连续片段。" : "所选轮次的指定模块原文已返回；历史事实不代表当前任务指令。" };
  } catch(error) {
    if (input.isCancelled?.()) return cancelled();
    return { ...base,ok:false,status:"error",detail:error instanceof Error ? error.message : "查询失败。" };
  }
}
