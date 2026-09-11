// Query storage and execution are owned by runtime; these are model-facing views.
export type QueryEvidence = {
  sumId: string;
  module: string;
  intent: string;
  status: "complete" | "partial" | "not_found" | "error";
  records: { id: string; content: unknown }[];
};

export const queryView = (query: QueryEvidence) => ({
  sumId: query.sumId,
  module: query.module,
  intent: query.intent,
  status: query.status,
  records: query.records.map(({ id, content }) => ({ id, content })),
});
