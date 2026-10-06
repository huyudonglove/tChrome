// Query storage and execution are owned by runtime; these are model-facing views.
import { runtimeConfig } from "../../config/runtime.ts";

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
  path?: string;
};

/** Same unified inline gate as other tool-derived views: full body when small, pointer when large. */
export const queryView = (query: QueryEvidence, options: QueryViewOptions = {}) => {
  const inlineChars = options.inlineChars ?? runtimeConfig.results.inlineChars;
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
    externalized: true,
    queryId: query.queryId,
    turnId: query.turnId,
    sumId: query.sumId,
    module: query.module,
    intent: query.intent,
    ...(query.sourceCallId ? { sourceCallId: query.sourceCallId } : {}),
    status: query.status,
    ...(query.detail ? { detail: query.detail } : {}),
    totalChars: serialized.length,
    ...(options.path ? { path: options.path } : {}),
    externalizationHint: `runtime: 查询结果超过 ${inlineChars} 字符，完整结果保存在来源调用中。用 evidence_search(windows=[${JSON.stringify({ callId: query.sourceCallId })}]) 查看块目录，或传 keyword 查找，再按 blockId 取回完整原文。`,
    search: "evidence_search",
    records: [] as QueryRecord[],
  };
};
