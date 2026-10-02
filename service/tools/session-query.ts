import { readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { ToolIOItem } from "../types.ts";
import { listConversationIds, loadToolRows, paths } from "../runtime/store.ts";
import { runtimeConfig } from "../config/runtime.ts";

/**
 * A return is externalized once its full text no longer fits the inline gate. The inline
 * `return.text` is then a structural summary, so anything reading the body back has to go
 * through evidence_search. Size is the reliable signal here; the flag itself is optional.
 */
const INLINE_GATE_CHARS = (): number => runtimeConfig.results.inlineChars;

type Row = ToolIOItem & { return: ToolIOItem["return"] & { path?: string; externalized?: boolean } };

const rowsOf = (dataDir: string, cvId: string): Row[] => {
  try {
    return loadToolRows(dataDir, cvId) as Row[];
  } catch {
    return [];
  }
};

const textOf = (input: Record<string, unknown>, key: string, fallback = ""): string => {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
};

const intOf = (input: Record<string, unknown>, key: string, fallback: number): number => {
  const value = Number(input[key]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
};

const isExternalized = (row: Row): boolean => {
  if (typeof row.return?.externalized === "boolean") return row.return.externalized;
  return (row.return?.totalChars ?? 0) > INLINE_GATE_CHARS();
};

const argsOf = (row: Row): Record<string, unknown> => {
  const raw = row.arguments as unknown;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
};

const dirBytes = (root: string, budget = { nodes: 0, max: 400_000 }): { bytes: number; truncated: boolean } => {
  let bytes = 0;
  let truncated = false;
  const walk = (dir: string): void => {
    if (truncated) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget.nodes >= budget.max) {
        truncated = true;
        return;
      }
      budget.nodes += 1;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        bytes += statSync(full).size;
      } catch {
        // A file can vanish mid-walk (rotation, cleanup); skipping it keeps the estimate useful.
      }
    }
  };
  walk(root);
  return { bytes, truncated };
};

const countFiles = (dir: string): number => {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
};

const filterRows = (rows: Row[], input: Record<string, unknown>, keyword: string): Row[] => {
  const tool = textOf(input, "tool");
  const turnId = textOf(input, "turnId");
  const needle = keyword.toLowerCase();
  return rows.filter((row) => {
    if (tool && row.name !== tool) return false;
    if (turnId && row.turnId !== turnId) return false;
    if (needle) {
      const haystack = [row.name, row.callId, JSON.stringify(argsOf(row)), row.return?.text ?? ""].join("\n").toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
};

const listConversations = (dataDir: string): Record<string, unknown> => {
  const ids = listConversationIds(dataDir);
  const withStats = ids.map((id) => {
    const p = paths(dataDir, id);
    const { bytes, truncated } = dirBytes(p.conv);
    return { conversationId: id, turns: countFiles(p.turns), bytes, sizeTruncated: truncated };
  });
  return { ok: true, mode: "conversations", conversations: withStats };
};

export function runSessionQuery(
  dataDir: string,
  input: Record<string, unknown> = {},
  currentConversationId?: string,
): Record<string, unknown> {
  const mode = textOf(input, "mode", "summary");
  if (mode === "conversations") return listConversations(dataDir);

  const cvId = textOf(input, "conversationId") || currentConversationId || "";
  if (!cvId) {
    return { ok: false, faultCode: "missing_conversation", error: "缺 conversationId：未提供也无法回落到当前会话" };
  }
  const known = listConversationIds(dataDir);
  if (known.length && !known.includes(cvId)) {
    return { ok: false, faultCode: "unknown_conversation", error: `会话 ${cvId} 不存在`, conversations: known };
  }

  const rows = rowsOf(dataDir, cvId);
  const keyword = textOf(input, "keyword");
  const scoped = filterRows(rows, input, keyword);
  const externalized = scoped.filter(isExternalized);
  const totalChars = scoped.reduce((sum, row) => sum + (row.return?.totalChars ?? 0), 0);

  if (mode === "summary") {
    const byTurn = new Map<string, number>();
    const byTool = new Map<string, number>();
    for (const row of rows) {
      byTurn.set(row.turnId, (byTurn.get(row.turnId) ?? 0) + 1);
      byTool.set(row.name, (byTool.get(row.name) ?? 0) + 1);
    }
    const turnIds = [...byTurn.keys()].sort();
    return {
      ok: true,
      mode,
      conversationId: cvId,
      calls: rows.length,
      distinctTools: byTool.size,
      turns: byTurn.size,
      firstTurnId: turnIds[0] ?? null,
      lastTurnId: turnIds[turnIds.length - 1] ?? null,
      externalizedCalls: rows.filter(isExternalized).length,
      totalReturnChars: rows.reduce((sum, row) => sum + (row.return?.totalChars ?? 0), 0),
      events: countFiles(paths(dataDir, cvId).events),
    };
  }

  if (mode === "tools") {
    const limit = intOf(input, "top", 40);
    const argumentKey = textOf(input, "argumentKey");
    const buckets = new Map<string, { calls: number; returnChars: number; externalized: number; values: Map<string, number> }>();
    for (const row of scoped) {
      const hit = buckets.get(row.name) ?? { calls: 0, returnChars: 0, externalized: 0, values: new Map<string, number>() };
      hit.calls += 1;
      hit.returnChars += row.return?.totalChars ?? 0;
      if (isExternalized(row)) hit.externalized += 1;
      if (argumentKey) {
        const value = argsOf(row)[argumentKey];
        if (value !== undefined && value !== null) {
          const key = typeof value === "object" ? JSON.stringify(value) : String(value);
          hit.values.set(key, (hit.values.get(key) ?? 0) + 1);
        }
      }
      buckets.set(row.name, hit);
    }
    const tools = [...buckets.entries()]
      .map(([name, hit]) => ({
        name,
        calls: hit.calls,
        returnChars: hit.returnChars,
        externalized: hit.externalized,
        ...(argumentKey
          ? { argumentKey, argumentValues: [...hit.values.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([value, count]) => ({ value, count })) }
          : {}),
      }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, limit);
    return { ok: true, mode, conversationId: cvId, distinctTools: buckets.size, tools };
  }

  if (mode === "turns") {
    const limit = intOf(input, "top", 30);
    const buckets = new Map<string, { calls: number; tools: Set<string>; externalized: number; returnChars: number }>();
    for (const row of scoped) {
      const hit = buckets.get(row.turnId) ?? { calls: 0, tools: new Set<string>(), externalized: 0, returnChars: 0 };
      hit.calls += 1;
      hit.tools.add(row.name);
      if (isExternalized(row)) hit.externalized += 1;
      hit.returnChars += row.return?.totalChars ?? 0;
      buckets.set(row.turnId, hit);
    }
    const turns = [...buckets.entries()]
      .map(([turnId, hit]) => ({ turnId, calls: hit.calls, distinctTools: hit.tools.size, externalized: hit.externalized, returnChars: hit.returnChars }))
      .sort((a, b) => (a.turnId < b.turnId ? 1 : -1))
      .slice(0, limit);
    return { ok: true, mode, conversationId: cvId, totalTurns: buckets.size, turns };
  }

  if (mode === "externalized") {
    const limit = intOf(input, "limit", 50);
    const items = externalized
      .sort((a, b) => (b.return?.totalChars ?? 0) - (a.return?.totalChars ?? 0))
      .slice(0, limit)
      .map((row) => ({
        callId: row.callId,
        name: row.name,
        turnId: row.turnId,
        totalChars: row.return?.totalChars ?? 0,
        ...(row.return?.path ? { path: row.return.path } : {}),
      }));
    return {
      ok: true,
      mode,
      conversationId: cvId,
      externalizedCalls: externalized.length,
      items,
      hint: "取全文用 evidence_search(windows=[{callId, keyword|startLine}])",
    };
  }

  if (mode === "calls") {
    const limit = intOf(input, "limit", 50);
    const items = scoped
      .sort((a, b) => (a.callId < b.callId ? -1 : 1))
      .slice(0, limit)
      .map((row) => ({
        callId: row.callId,
        name: row.name,
        turnId: row.turnId,
        stage: row.return?.stage ?? null,
        totalChars: row.return?.totalChars ?? 0,
        externalized: isExternalized(row),
      }));
    return { ok: true, mode, conversationId: cvId, matched: scoped.length, returned: items.length, totalChars, items };
  }

  return { ok: false, faultCode: "invalid_mode", error: `不支持的 mode=${mode}` };
}
