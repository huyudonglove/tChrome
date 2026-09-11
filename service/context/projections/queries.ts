// Query storage and execution are owned by runtime; these are model-facing views.
export type QueryRecord = Record<string, unknown> & { turnId: string } & (
  | { id: string }
  | { callId: string }
  | { memoryId: string }
  | { sumId: string }
  | { queryId: string }
);

export type QueryEvidence = {
  queryId: string;
  turnId: string;
  sumId: string;
  module: string;
  intent: string;
  status: "complete" | "partial" | "not_found" | "error";
  records: QueryRecord[];
};

export const queryView = (query: QueryEvidence) => ({
  queryId: query.queryId,
  turnId: query.turnId,
  sumId: query.sumId,
  module: query.module,
  intent: query.intent,
  status: query.status,
  records: query.records.map((record) => ({ ...record })),
});
