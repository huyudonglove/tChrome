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
  lineWidth?: number;
  path?: string;
};

/** Same unified inline gate as other tool-derived views: full body when small, pointer when large. */
export const queryView = (query: QueryEvidence, options: QueryViewOptions = {}) => {
  const inlineChars = options.inlineChars ?? 4000;
  const previewChars = options.previewChars ?? 100;
  const searchContextChars = options.searchContextChars ?? 400;
  const lineWidth = options.lineWidth ?? 100;
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
  const totalLines = serialized.length <= 0 ? 0 : Math.ceil(serialized.length / lineWidth);
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
    totalLines,
    lineWidth,
    preview: serialized.slice(0, previewChars),
    ...(options.path ? { path: options.path } : {}),
    message: `runtime: 查询结果超过 ${inlineChars} 字符，已按 ${lineWidth} 字/行缓存本地（共 ${totalLines} 行）；preview 为原文前 ${previewChars} 字符。用 evidence.search 按 callId 与 keyword，或只传 startLine（约 ${searchContextChars} 字窗口）检索。`,
    search: "evidence.search",
    records: [] as QueryRecord[],
  };
};
