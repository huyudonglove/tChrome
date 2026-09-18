// Query storage and execution are owned by runtime; these are model-facing views.
export type QueryRecord = Record<string, unknown> & { turnId: string };

export type QueryEvidence = {
  queryId: string;
  turnId: string;
  sumId: string;
  module: string;
  intent: string;
  status: "complete" | "not_found" | "error";
  records: QueryRecord[];
  sourceCallId?: string;
  detail?: string;
};

export type QueryViewOptions = {
  inlineChars?: number;
  previewChars?: number;
  searchContextChars?: number;
  path?: string;
};

/** Same unified inline gate as other tool-derived views: full body when small, pointer when large. */
export const queryView = (query: QueryEvidence, options: QueryViewOptions = {}) => {
  const inlineChars = options.inlineChars ?? 4000;
  const previewChars = options.previewChars ?? 100;
  const searchContextChars = options.searchContextChars ?? 400;
  const view = {
    queryId: query.queryId,
    turnId: query.turnId,
    sumId: query.sumId,
    module: query.module,
    intent: query.intent,
    ...(query.sourceCallId ? { sourceCallId: query.sourceCallId } : {}),
    ...(query.detail ? { detail: query.detail } : {}),
    status: query.status,
    records: query.records.map((record) => ({ ...record })),
  };
  const serialized = JSON.stringify(view);
  if (serialized.length <= inlineChars) return view;
  return {
    ok: true,
    externalized: true,
    queryId: query.queryId,
    turnId: query.turnId,
    sumId: query.sumId,
    module: query.module,
    intent: query.intent,
    ...(query.sourceCallId ? { sourceCallId: query.sourceCallId } : {}),
    status: query.status,
    totalChars: serialized.length,
    preview: serialized.slice(0, previewChars),
    ...(options.path ? { path: options.path } : {}),
    message: `runtime: 查询结果超过 ${inlineChars} 字符，全文已缓存本地；preview 为原文前 ${previewChars} 字符。请用 evidence.search 按 callId 与 keyword 取关键字附近上下文（默认 ±${searchContextChars} 字符）。`,
    search: "evidence.search",
    records: [] as QueryRecord[],
  };
};
