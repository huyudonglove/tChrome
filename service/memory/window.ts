import type { Memories, MemoryRecord } from "./types.ts";

/** Scope index budget: the catalog is a hint, never a place to dump whole memories. */
export const SCOPE_INDEX_MAX_SCOPES = 10;
export const SCOPE_INDEX_MAX_CHARS = 800;
const SUMMARY_MAX = 60;
const turnNo = (turnId: string) => Number.parseInt(turnId.replace(/^\D+/, ""), 10) || 0;

/**
 * Ownership check: no scope (legacy data) is global and always injected; a scoped record needs an
 * active scope. Fail-open: with no derivable scope (new conversation, no path-bearing tool call yet)
 * nothing can be ruled out, so inject everything rather than silently hiding every memory.
 */
const isInjected = (record: MemoryRecord, activeScopes: readonly string[]): boolean =>
  !record.scope || activeScopes.length === 0 || activeScopes.includes(record.scope);

const gist = (record: MemoryRecord): string => {
  const raw = (record.summary ?? record.text).trim().split("\n")[0] ?? "";
  return raw.length > SUMMARY_MAX ? `${raw.slice(0, SUMMARY_MAX)}…` : raw;
};

/**
 * Turn an absolute path into an ownership key. The key is the project directory, not the
 * repository or the goal: same repo, two unrelated tasks share one scope. Unknown roots
 * (non-macOS home layouts) fall back to the first path segment after the user name.
 */
const scopeFromPath = (value: string): string | null => {
  if (!value.startsWith("/")) return null;
  const parts = value.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "Users") return null;
  const root = parts[2];
  if (!root) return null;
  if (root === "Projects") return parts[3] ?? null;
  if (root === "Library") {
    const support = parts.indexOf("Application Support");
    return support >= 0 ? (parts[support + 1] ?? null) : null;
  }
  return root;
};

/** Count each scope once per tool call so a single call listing many paths cannot dominate. */
export function deriveActiveScopes(calls: readonly { arguments?: unknown }[], window = 40): string[] {
  const counts = new Map<string, number>();
  for (const call of calls.slice(-window)) {
    const seen = new Set<string>();
    const walk = (node: unknown, depth: number): void => {
      if (depth > 4) return;
      if (typeof node === "string") {
        const scope = scopeFromPath(node);
        if (scope) seen.add(scope);
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) walk(item, depth + 1);
        return;
      }
      if (node && typeof node === "object") {
        for (const value of Object.values(node)) walk(value, depth + 1);
      }
    };
    walk(call.arguments, 0);
    for (const scope of seen) counts.set(scope, (counts.get(scope) ?? 0) + 1);
  }
  // Top two: a turn legitimately touches one project plus a neighbour (service data dir, sibling repo).
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([scope]) => scope);
}

/** Preserve identity and content. Runtime owns coverage; projection never prunes records. */
export function projectMemories(memories: Memories, activeScopes: readonly string[] = []): Record<keyof Memories, string> {
  return {
    project: JSON.stringify(memories.project.filter((record) => isInjected(record, activeScopes)).map(memoryView), null, 2),
    conversation: JSON.stringify(memories.conversation.map(memoryView), null, 2),
  };
}

/** One gist per memory of scopes that were not injected, so the model knows they exist without their text. */
export function renderScopeIndex(memories: Memories, activeScopes: readonly string[] = []): string {
  const groups = new Map<string, MemoryRecord[]>();
  for (const record of memories.project) {
    if (isInjected(record, activeScopes)) continue;
    const bucket = groups.get(record.scope as string) ?? [];
    bucket.push(record);
    groups.set(record.scope as string, bucket);
  }
  if (groups.size === 0) return "";
  const latestTurn = (records: MemoryRecord[]): number => Math.max(...records.map((record) => turnNo(record.turnId)));
  const ordered = [...groups.entries()].sort((a, b) => latestTurn(b[1]) - latestTurn(a[1]));
  const shown: string[] = [];
  let chars = 0;
  let hidden = 0;
  for (const [scope, records] of ordered) {
    if (shown.length >= SCOPE_INDEX_MAX_SCOPES) {
      hidden += 1;
      continue;
    }
    const line = `- ${scope}（${records.length} 条）\n${records.map((record) => `    · ${gist(record)}`).join("\n")}`;
    if (chars + line.length > SCOPE_INDEX_MAX_CHARS && shown.length > 0) {
      hidden = ordered.length - shown.length;
      break;
    }
    shown.push(line);
    chars += line.length;
  }
  const tail = hidden > 0 ? `\n（另有 ${hidden} 个 scope 未列出）` : "";
  return `记忆目录（未注入的 scope，按最近活跃排序）:\n${shown.join("\n")}${tail}`;
}

const memoryView = ({ memoryId, turnId, sourceCallId, sourceConversationId, text }: MemoryRecord) => ({ memoryId, turnId, sourceCallId, sourceConversationId, text });
