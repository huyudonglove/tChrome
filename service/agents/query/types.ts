export const queryModules = ["userInput", "toolIO", "observations", "workspace", "notes", "memoryWrites", "stopReason", "queryHistory", "summaries"] as const;
export type QueryModule = typeof queryModules[number];
export type QueryRequest = { sumId: string; module: QueryModule; intent: string; file?: string };
export type QueryResult = {
  ok: boolean; status: "complete" | "not_found" | "error" | "cancelled";
  sumId: string; module: QueryModule; intent: string; file?: string; records: Record<string, unknown>[];
  faultCode?: string; detail?: string;
};
