import type { SummaryFields } from "../../context-archive/types.ts";
export type LoopSummary = SummaryFields & { id: string; loopIds: string[]; level?: number; from?: string[] };
/** 连续编号合并成区间（如 loop_951–loop_981）：窗口省字符，来源不丢。 */
export const compactLoopIds = (ids: string[] = []): string[] => {
  const parse = (id: string) => /^(.*_)(\d+)$/.exec(id);
  const parts: string[] = [];
  for (let i = 0; i < ids.length;) {
    const head = parse(ids[i]!);
    let j = i + 1;
    if (head) while (j < ids.length) {
      const prev = parse(ids[j - 1]!); const next = parse(ids[j]!);
      if (!prev || !next || next[1] !== head[1] || Number(next[2]) !== Number(prev[2]) + 1) break;
      j += 1;
    }
    if (!head || j - i === 1) parts.push(ids[i]!);
    else { const tail = parse(ids[j - 1]!)!; parts.push(`${head[1]}${head[2]}–${tail[1]}${tail[2]}`); }
    i = j;
  }
  return parts;
};
export const loopSummaryView = (records: LoopSummary[] = []) => records.map(({ id, loopIds, ...record }) => ({ sumId: id, loopIds: compactLoopIds(loopIds), ...record }));
