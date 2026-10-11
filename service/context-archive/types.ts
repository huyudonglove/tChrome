export type SummaryFields = { userRequest: string; constraints: string[]; state: string; pending: string[]; decisions: string[] };
export const compressionModules = ["conversationHistory"] as const;
export type CompressionModule = typeof compressionModules[number];
export type SourceRecord = { id: string; content: unknown };
export type CompressionRecord = SummaryFields & {
  id: string;
  module: CompressionModule;
  level: number;
  loopIds: string[];
  sourceIds: string[];
  createdAt: string;
};
export type CompressionIndex = {
  version: 1;
  module: CompressionModule;
  entries: CompressionRecord[];
  activeIds: string[];
  coveredSourceIds: string[];
};
