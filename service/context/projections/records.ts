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
/** 日期只保留到天，且与提示词注入的当前日期同一口径：按运行环境本地时区取年月日。 */
export const dateOnly = (value?: string): string | undefined => {
  if (typeof value !== "string") return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: string) => parts.find(item => item.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
};
/** 归档侧列（module/sourceIds）只服务落盘与查询，不进窗口；摘要正文、loopIds、level/from 与粗粒度 date 照旧保留。 */
type ArchiveColumns = { module?: string; sourceIds?: string[]; createdAt?: string };
export const loopSummaryView = (records: LoopSummary[] = []) =>
  records.map(({ id, loopIds, module: _module, sourceIds: _sourceIds, createdAt, ...record }: LoopSummary & ArchiveColumns) => {
    const date = dateOnly(createdAt);
    return { sumId: id, loopIds: compactLoopIds(loopIds), ...(date ? { date } : {}), ...record };
  });
