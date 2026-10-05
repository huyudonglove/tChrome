import { NEUTRAL_TOOLS } from "./escalation.ts";
import { toolArgFiles } from "../agents/query/file-filter.ts";
import type { Ledger, ToolIOItem } from "../types.ts";

/** 附在工具返回末尾的工作区建议；下次出网前 strip，只保留最新一条。 */
export const WORKSPACE_SUGGEST_MARKER = "runtime: 工作区建议";

/** boundSeq（从 0 起）→ b01、b02… */
export const formatBoundId = (seq: number): string => `b${String(seq).padStart(2, "0")}`;

/** 本轮最近一批里的业务调用（去掉记账/控制类）。 */
export function defaultWorkspaceCallIds(ledger: Ledger, turnId: string): string[] {
  const rows = ledger.toolIO.filter((r) => r.turnId === turnId && r.batchId);
  const lastBatch = rows.at(-1)?.batchId;
  if (!lastBatch) return [];
  return rows
    .filter((r) => r.batchId === lastBatch && !NEUTRAL_TOOLS.has(r.name))
    .map((r) => r.callId);
}

/** 给一批返回配建议：无业务调用返回 null（纯收口/记账批不打扰）。 */
export function buildWorkspaceSuggestion(batchRows: ToolIOItem[]): string | null {
  const biz = batchRows.filter((r) => !NEUTRAL_TOOLS.has(r.name));
  if (!biz.length) return null;
  const tally = new Map<string, number>();
  for (const row of biz) tally.set(row.name, (tally.get(row.name) ?? 0) + 1);
  const detail = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name}×${n}`)
    .join("、");
  // 本批触及的文件直接列出来，模型照抄进 files[] 即可，不用回翻 toolIO。
  const files = [...new Set(biz.flatMap((row) => toolArgFiles(row.arguments)))];
  const fileHint = files.length ? `本批涉及文件：${files.join("、")}（照抄进 files，不涉及文件可不传）。` : "";
  return `${WORKSPACE_SUGGEST_MARKER} 本批出网共 ${biz.length} 次调用（${detail}）。${fileHint}建议用 workspace_write 写一条因果：op=这批做了什么，value=得到什么结论，files[]=涉及的文件路径（可带行区间，不涉及文件可不传）。可写可不写，只记「不写就会忘」的结论。`;
}

/** 去掉历史建议，本轮只保留最新一条。 */
export function stripWorkspaceSuggestion(text: string): string {
  const at = text.indexOf(WORKSPACE_SUGGEST_MARKER);
  return at >= 0 ? text.slice(0, at).trimEnd() : text;
}
