// "output" is the legacy name of "stopReason"; archived turns written before the
// rename still carry the field as `output`, so both module names are accepted.
export const queryModules = ["userInput", "goalChanges", "toolIO", "observations", "memoryWrites", "stopReason", "output", "queryHistory", "summaries"] as const;
export type QueryModule = typeof queryModules[number];
export type QueryRequest = { sumId: string; module: QueryModule; intent: string };
export type QueryResult = {
  ok: boolean; status: "complete" | "not_found" | "error" | "cancelled";
  sumId: string; module: QueryModule; intent: string; records: Record<string, unknown>[];
  faultCode?: string; detail?: string;
};
