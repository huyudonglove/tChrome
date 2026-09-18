import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compressionArchiveFieldsMarkdown, interpolate } from "../../../context/modules.ts";

export type CompressionContextModule = {
  id: string;
  order: number;
  file: string;
  consumers: string[];
  description?: string;
  inject?: string[];
};

export type CompressionContextRegistry = {
  version: number;
  modules: CompressionContextModule[];
};

const cache = new Map<string, CompressionContextRegistry>();

export function loadCompressionContextRegistry(repoRoot: string): CompressionContextRegistry {
  const hit = cache.get(repoRoot);
  if (hit) return hit;
  const raw = JSON.parse(
    readFileSync(join(repoRoot, "service/agents/compression/context/modules.json"), "utf8"),
  ) as CompressionContextRegistry;
  if (raw.version !== 1 || !raw.modules?.length) throw new Error("invalid compression context registry");
  const ids = new Set(raw.modules.map(row => row.id));
  if (ids.size !== raw.modules.length) throw new Error("duplicate compression context module id");
  cache.set(repoRoot, raw);
  return raw;
}

/** All System modules are XML B blocks; order comes from compression modules.json. */
export function loadCompressionSystemModules(repoRoot: string): { id: string; text: string }[] {
  const registry = loadCompressionContextRegistry(repoRoot);
  return [...registry.modules]
    .sort((a, b) => a.order - b.order)
    .map(row => {
      const path = join(repoRoot, "service/agents/compression/context", row.file);
      let text = readFileSync(path, "utf8").trim();
      const slots: Record<string, string> = {};
      for (const key of row.inject ?? []) {
        if (key === "archiveFields") slots.archiveFields = compressionArchiveFieldsMarkdown(repoRoot);
      }
      if (Object.keys(slots).length) text = interpolate(text, slots);
      return { id: row.id, text };
    });
}

export function compressionSystemFromModules(repoRoot: string): string {
  return loadCompressionSystemModules(repoRoot).map(row => row.text).join("\n\n");
}
