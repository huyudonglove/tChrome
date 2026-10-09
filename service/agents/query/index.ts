import { loadLedger } from "../../runtime/store.ts";
import { errorInfo } from "../../../shared/errors.ts";
import { runtimeConfig } from "../../config/runtime.ts";
import { createHash } from "node:crypto";
import type { Provider } from "../../types.ts";
import { requestMatches, type QueryCandidate } from "./protocol.ts";
import { FILE_FILTER_MODULES, normalizeFileQuery, recordTouchesFile } from "./file-filter.ts";
import { loadIndex, resolveSources } from "../../context-archive/store.ts";
import { queryModules, type QueryRequest, type QueryResult } from "./types.ts";
export type { QueryRequest, QueryResult, QueryModule } from "./types.ts";

type QueryInput = QueryRequest & { dataDir: string; conversationId: string; repoRoot: string; provider: Provider; isCancelled?: () => boolean };
type RecordValue = Record<string, unknown>;
const fallbackRecordKey = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const recordKeyFor = (record: RecordValue): string => {
  const nativeId = ["callId", "pageId", "recordId", "memoryId", "queryId", "id"]
    .map(key => record[key]).find((value): value is string => typeof value === "string" && value.length > 0);
  return nativeId ?? fallbackRecordKey(record);
};

/** Only traverse the requested summary's immutable source graph; retrieval never writes archive state. */
export async function queryContext(input: QueryInput): Promise<QueryResult> {
  const file = normalizeFileQuery(input.file);
  const base = { ...(input.sumId ? { sumId: input.sumId } : { loopId: input.loopId }), module: input.module, intent: input.intent, ...(file ? { file } : {}), records: [] };
  const cancelled = (): QueryResult => ({ ...base, ok: false, status: "cancelled", faultCode: "stopped", detail: "查询已取消。" });
  try {
    if (!queryModules.includes(input.module) || (Boolean(input.sumId) === Boolean(input.loopId)) || !/^[A-Za-z0-9_-]{1,100}$/.test(input.sumId ?? input.loopId ?? "")
      || typeof input.intent !== "string" || !input.intent.trim() || input.intent.length > runtimeConfig.results.inlineChars) throw new Error("查询参数无效。");
    if (input.isCancelled?.()) return cancelled();
    const index = loadIndex(input.dataDir, input.conversationId, "conversationHistory");
    const byId = new Map(index.entries.map(entry => [entry.id, entry]));
    if (input.sumId && !byId.has(input.sumId)) throw new Error("sumId 不属于本会话的归档。");
    const directLoop = input.loopId ? loadLedger(input.dataDir, input.conversationId).loops.find(loop => loop.id === input.loopId) : undefined;
    if (input.loopId && !directLoop) return { ...base, ok: true, status: "not_found", detail: "本会话没有指定 loop。" };
    const sources = input.sumId ? resolveSources(input.dataDir, input.conversationId, "conversationHistory", [input.sumId]) : [{ id: directLoop!.id, content: directLoop! }];
    const records: RecordValue[] = [];
    const seen = new Set<string>();
    const add = (value: unknown, loopId: string) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("归档模块记录格式无效。");
      const original = value as RecordValue;
      const record = { ...original, loopId };
      const key = JSON.stringify(record);
      if (!seen.has(key)) { seen.add(key); records.push(record); }
    };
    if (input.module === "summaries") {
      const visited = new Set<string>();
      const visit = (id: string) => {
        if (visited.has(id)) return; visited.add(id);
        const entry = byId.get(id); if (!entry) return;
        const { id: sumId, ...fields } = entry;
        add({ sumId, ...fields }, entry.loopIds[0]!);
        entry.sourceIds.forEach(visit);
      };
      if (input.sumId) visit(input.sumId);
      else for (const entry of index.entries) if (entry.loopIds.includes(input.loopId!)) visit(entry.id);
    } else for (const source of sources) {
      const loop = source.content as RecordValue;
      if (!loop || typeof loop.id !== "string") throw new Error("归档缺少来源 loop ID。");
      const values = input.module === "loops" ? loop : loop[input.module];
      if (values == null) continue;
      for (const value of Array.isArray(values) ? values : [values]) add(value, loop.id);
    }

    if (!records.length) return { ...base, ok: true, status: "not_found", detail: "指定摘要来源中没有匹配的模块记录。" };
    // File pre-filter: narrow candidates to records touching the file before the
    // agent sees them. A miss short-circuits without spending a model roundtrip.
    let candidates = records;
    if (file) {
      if (!(FILE_FILTER_MODULES as readonly string[]).includes(input.module)) {
        return { ...base, ok: true, status: "not_found", detail: `module=${input.module} 的记录不带文件归因，file 支持 loops / runtime / helm / summaries。` };
      }
      candidates = records.filter((record) => recordTouchesFile(record, input.module, file));
      if (!candidates.length) return { ...base, ok: true, status: "not_found", detail: `指定摘要来源中没有涉及文件 ${file} 的模块记录（module=${input.module}）。` };
    }
    if (input.isCancelled?.()) return cancelled();
    const byLoop = new Map<string, QueryCandidate>();
    for (const record of candidates) {
      const loopId = record.loopId as string;
      const recordKey = recordKeyFor(record);
      const candidate = byLoop.get(loopId);
      if (candidate) {
        candidate.records.push(record);
        candidate.recordKeys?.push(recordKey);
      } else {
        byLoop.set(loopId, { loopId, records: [record], recordKeys: [recordKey] });
      }
    }
    const selection = await requestMatches({ provider: input.provider, repoRoot: input.repoRoot,
      request: { ...(input.sumId ? { sumId: input.sumId } : { loopId: input.loopId }), module: input.module, intent: input.intent, ...(file ? { file } : {}) }, candidates: [...byLoop.values()] });
    const selected = selection.loopIds;
    if (input.isCancelled?.()) return cancelled();
    if (!selected.length) return { ...base, ok: true, status: "not_found", detail: "指定摘要来源中没有匹配的模块记录。" };
    const selectedRecordKeys = selection.recordKeys;
    const matches = candidates.filter(record => selected.includes(record.loopId as string)
      && (!selectedRecordKeys?.length || selectedRecordKeys.includes(recordKeyFor(record))));
    // Runtime applies the unified inline gate; Query Agent may narrow to selected record keys.
    return { ...base, ok: true, status: "complete", records: matches };
  } catch(error) {
    if (input.isCancelled?.()) return cancelled();
    return { ...base, ok: false, status: "error", ...errorInfo(error, "query_failed") };
  }
}
