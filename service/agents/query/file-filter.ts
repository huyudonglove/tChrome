/** File-scoped retrieval for the Query Agent: which archived records touch a file. */

/** Normalized file filter, or null when absent/blank (no filtering). */
export function normalizeFileQuery(file: unknown): string | null {
  if (typeof file !== "string") return null;
  const trimmed = file.trim();
  return trimmed ? trimmed : null;
}

/** Bidirectional substring: absolute queries match relative attributions and vice versa. */
const touches = (attributed: string, query: string): boolean => {
  // A trailing line range (src/auth.ts:120-180) must not break matching either way.
  const bare = attributed.replace(/:\d+(-\d+)?$/, "");
  return bare.includes(query) || query.includes(bare);
};

/** File path arguments of read/write/execute tools (path/items/filename/source/destination/cwd). */
export function toolArgFiles(args: unknown): string[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const record = args as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ["path", "filename", "file", "source", "destination", "cwd"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) out.push(value.trim());
  }
  const items = record.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const p = (item as Record<string, unknown>).path;
        if (typeof p === "string" && p.trim()) out.push(p.trim());
      }
    }
  }
  return out;
}

/** File attribution follows original call arguments and runtime payloads. */
export function recordTouchesFile(record: Record<string, unknown>, module: string, file: string): boolean {
  if (module === "summaries") return ["summary", "userRequest", "actions", "result", "reflection"].some(key => typeof record[key] === "string" && (record[key] as string).includes(file));
  if (!["loops", "runtime", "helm"].includes(module)) return false;
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(visit);
    const row = value as Record<string, unknown>;
    if (toolArgFiles(row).some(path => touches(path, file))) return true;
    if (Array.isArray(row.files) && row.files.some(path => typeof path === "string" && touches(path, file))) return true;
    return Object.values(row).some(visit);
  };
  return visit(record);
}
export const FILE_FILTER_MODULES = ["loops", "runtime", "helm", "summaries"] as const;
