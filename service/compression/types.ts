export const compressionModules = ["userInputHistory", "pageObservedHistory", "conversationMemory", "toolIO"] as const;
export type CompressionModule = typeof compressionModules[number];
export type SourceRecord = { id: string; content: unknown };
export type CompressionRecord = {
  id: string;
  module: CompressionModule;
  level: number;
  tag: string;
  summary: string;
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
