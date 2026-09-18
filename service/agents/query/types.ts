export const queryModules = ["userInput", "goalChanges", "toolIO", "pageObservations", "memoryWrites", "output", "queryHistory", "summaries"] as const;
export type QueryModule = typeof queryModules[number];
export type QueryRequest = { sumId: string; module: QueryModule; intent: string };
export type QueryResult = {
  ok: boolean; status: "complete" | "not_found" | "error" | "cancelled";
  sumId: string; module: QueryModule; intent: string; records: Record<string, unknown>[];
  faultCode?: string; detail?: string;
};
