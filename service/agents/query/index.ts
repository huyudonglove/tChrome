import { runtimeConfig } from "../../config/runtime.ts";
import { errorInfo } from "../../../shared/errors.ts";
import { createHash } from "node:crypto";
import type { Provider } from "../../types.ts";
import { requestMatches, type QueryCandidate } from "./protocol.ts";
import { loadIndex, resolveSources } from "../../context-archive/store.ts";
import { queryModules, type QueryRequest, type QueryResult } from "./types.ts";
export type { QueryRequest, QueryResult, QueryModule } from "./types.ts";

type QueryInput = QueryRequest & { dataDir: string; conversationId: string; repoRoot: string; provider: Provider; isCancelled?: () => boolean };
type RecordValue = Record<string, unknown>;
const RETURN_CHARS = runtimeConfig.query.returnChars;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function identity(record: RecordValue): RecordValue {
  return Object.fromEntries(Object.entries(record).filter(([key]) => ["id", "turnId", "callId", "memoryId", "queryId", "sumId", "batchId", "sourceCallId"].includes(key)));
}
function fragment(record: RecordValue, text: string, offset: number, length: number): RecordValue {
  return { ...identity(record), fragment: { offset, totalChars: text.length, text: text.slice(offset, offset + length) } };
}
/** Only traverse the requested summary's immutable source graph; retrieval never writes archive state. */
export async function queryContext(input: QueryInput): Promise<QueryResult> {
  const base = { sumId: input.sumId, module: input.module, intent: input.intent, records: [] };
  const cancelled = (): QueryResult => ({ ...base, ok: false, status: "cancelled", faultCode: "stopped", detail: "查询已取消。" });
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
      const byTurn = new Map<string, QueryCandidate>();
      for (const record of records) {
        const turnId = record.turnId as string;
        const candidate = byTurn.get(turnId);
        if (candidate) candidate.records.push(record);
        else byTurn.set(turnId, { turnId, records: [record] });
      }
      if (input.isCancelled?.()) return cancelled();
      selected = records.length ? await requestMatches({ provider: input.provider, repoRoot: input.repoRoot,
        request: { sumId: input.sumId, module: input.module, intent: input.intent }, candidates: [...byTurn.values()] }) : [];
      if (input.isCancelled?.()) return cancelled();
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
    };
  } catch(error) {
    if (input.isCancelled?.()) return cancelled();
    return { ...base,ok:false,status:"error",...errorInfo(error, "query_failed") };
  }
}
