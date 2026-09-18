import { readFileSync } from "node:fs";
import { join } from "node:path";

export type QueryContextModule = {
  id: string;
  order: number;
  file: string;
  consumers: string[];
  description?: string;
};

export type QueryContextRegistry = {
  version: number;
  modules: QueryContextModule[];
};

const cache = new Map<string, QueryContextRegistry>();

export function loadQueryContextRegistry(repoRoot: string): QueryContextRegistry {
  const hit = cache.get(repoRoot);
  if (hit) return hit;
  const raw = JSON.parse(
    readFileSync(join(repoRoot, "service/agents/query/context/modules.json"), "utf8"),
  ) as QueryContextRegistry;
  if (raw.version !== 1 || !raw.modules?.length) throw new Error("invalid query context registry");
  const ids = new Set(raw.modules.map(row => row.id));
  if (ids.size !== raw.modules.length) throw new Error("duplicate query context module id");
  cache.set(repoRoot, raw);
  return raw;
}

/** All System modules are XML B blocks; order comes from query modules.json. */
export function loadQuerySystemModules(repoRoot: string): { id: string; text: string }[] {
  const registry = loadQueryContextRegistry(repoRoot);
  return [...registry.modules]
    .sort((a, b) => a.order - b.order)
    .map(row => ({
      id: row.id,
      text: readFileSync(join(repoRoot, "service/agents/query/context", row.file), "utf8").trim(),
    }));
}

export function querySystemFromModules(repoRoot: string): string {
  return loadQuerySystemModules(repoRoot).map(row => row.text).join("\n\n");
}
