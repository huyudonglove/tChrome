import { readFileSync } from "node:fs";
import { join } from "node:path";

export type CompressionCoverage =
  | "turn"
  | "sourceCallId"
  | "batch"
  | "callId"
  | "queryId"
  | "settledTurnOnly"
  | "none";

export type CompressionSource = {
  id: string;
  archiveField: string | null;
  windowSlot: string | null;
  compress: boolean;
  coverage: CompressionCoverage;
  inputSemantics: string;
};

export type CompressionInventory = {
  version: number;
  description?: string;
  sources: CompressionSource[];
};

/** Envelope keys that always travel with an archive turn/segment; not window modules. */
export const COMPRESSION_ENVELOPE = ["conversationId", "turnId", "status", "createdAt", "completedAt", "sequence", "segment", "summaries", "segments"] as const;

let cache: { repoRoot: string; value: CompressionInventory } | null = null;

export function loadCompressionInventory(repoRoot: string): CompressionInventory {
  if (cache?.repoRoot === repoRoot) return cache.value;
  const raw = JSON.parse(readFileSync(join(repoRoot, "service/context/compression-inventory.json"), "utf8")) as CompressionInventory;
  if (raw.version !== 1 || !Array.isArray(raw.sources) || !raw.sources.length) {
    throw new Error("invalid compression inventory");
  }
  const ids = new Set(raw.sources.map(source => source.id));
  if (ids.size !== raw.sources.length) throw new Error("duplicate compression inventory source id");
  for (const source of raw.sources) {
    if (source.compress && !source.archiveField) throw new Error(`compress source missing archiveField: ${source.id}`);
  }
  cache = { repoRoot, value: raw };
  return raw;
}

export function compressedSources(inventory: CompressionInventory): CompressionSource[] {
  return inventory.sources.filter(source => source.compress && source.archiveField);
}

export function compressionArchiveFields(inventory: CompressionInventory): string[] {
  return compressedSources(inventory).map(source => source.archiveField!);
}

export function uncompressedWindowSlots(inventory: CompressionInventory): string[] {
  return inventory.sources.filter(source => !source.compress && source.windowSlot).map(source => source.windowSlot!);
}

/** Model-facing module section for compression Agent, always generated from the inventory. */
export function compressionModulesMarkdown(inventory: CompressionInventory): string {
  const active = compressedSources(inventory);
  const idle = uncompressedWindowSlots(inventory);
  const lines = active.map(source => `- ${source.archiveField}: ${source.inputSemantics}`);
  return [
    "## 模块",
    "",
    "下列模块由 Runtime 按 service/context/compression-inventory.json 组装，不是主模型当前窗口投影。toolIO 与 pageObservations 都会提供，彼此不做指针去重。字段增删以清单为准。",
    "",
    ...lines,
    "",
    `不参与压缩的窗口模块：${idle.map(name => `#${name}`).join("、")}。`,
  ].join("\n");
}
