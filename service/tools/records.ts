import type { ToolArguments } from "../types.ts";

export const FULL_RETURN_TOOLS = ["record.query"];

// Positions are zero-based UTF-16 offsets, matching JavaScript slice/indexOf.
export function queryRecord(args: ToolArguments, full: string | null): string {
  const source = { kind: args.kind, id: args.id, historical: true };
  if (full === null) return JSON.stringify({ ok: false, source, error: "记录不存在" });
  const meta = { ok: true, source, totalChars: full.length, positionUnit: "utf16", tool: "record.query", modes: ["inspect", "read", "search"] };
  if (args.mode === "inspect") {
    let structure: unknown = { format: "text", totalLines: full.split("\n").length };
    try {
      const value = JSON.parse(full);
      structure = { format: "json", type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
        ...(Array.isArray(value) ? { items: value.length } : value && typeof value === "object" ? { keys: Object.keys(value) } : {}) };
    } catch { /* Plain text uses line metadata. */ }
    return JSON.stringify({ ...meta, structure, start: 0, end: Math.min(400, full.length),
      text: full.slice(0, 400), hasMore: full.length > 400, nextOffset: full.length > 400 ? 400 : null });
  }
  const offset = args.offset as number;
  if (offset > full.length) return JSON.stringify({ ...meta, ok: false, error: "offset 超出记录范围" });
  if (args.mode === "read") {
    const end = Math.min(offset + (args.limit as number), full.length);
    return JSON.stringify({ ...meta, start: offset, end, text: full.slice(offset, end),
      hasMore: end < full.length, nextOffset: end < full.length ? end : null });
  }
  const query = args.query as string;
  const matches: { start: number; end: number; contextStart: number; contextEnd: number; text: string }[] = [];
  let cursor = offset;
  while (matches.length < (args.limit as number)) {
    const start = full.indexOf(query, cursor);
    if (start < 0) break;
    const end = start + query.length;
    const contextStart = Math.max(0, start - 100);
    const contextEnd = Math.min(full.length, end + 100);
    matches.push({ start, end, contextStart, contextEnd, text: full.slice(contextStart, contextEnd) });
    cursor = end;
  }
  const hasMore = full.indexOf(query, cursor) >= 0;
  return JSON.stringify({ ...meta, query, offset, matches, returnedCount: matches.length,
    hasMore, nextOffset: hasMore ? cursor : null });
}
