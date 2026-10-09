export const queryModules = ["loops", "runtime", "helm", "summaries"] as const;
export type QueryModule = typeof queryModules[number];
export type QueryRequest = { sumId?: string; loopId?: string; module: QueryModule; intent: string; file?: string };
export type QueryResult = {
  ok: boolean; status: "complete" | "not_found" | "error" | "cancelled";
  sumId?: string; loopId?: string; module: QueryModule; intent: string; file?: string; records: Record<string, unknown>[];
  faultCode?: string; detail?: string;
};
