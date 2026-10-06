import { NEUTRAL_TOOLS } from "./escalation.ts";
import { toolArgFiles } from "../agents/query/file-filter.ts";
import type { Ledger, ToolIOItem } from "../types.ts";

/** 工作区建议：进 User <runtimeNotices> 模块（与 conversation 平级），同 kind 只保留最新一条。 */
export const WORKSPACE_SUGGEST_MARKER = "runtime: 工作区建议";

/** boundSeq（从 0 起）→ b01、b02… */
export const formatBoundId = (seq: number): string => `b${String(seq).padStart(2, "0")}`;

/** 本轮最近一个含业务调用的批次；记账/控制调用不改变来源批次。 */
export function defaultWorkspaceCallIds(ledger: Ledger, turnId: string): string[] {
  const rows = ledger.toolIO.filter((r) => r.turnId === turnId && r.batchId && !NEUTRAL_TOOLS.has(r.name));
  const lastBatch = rows.at(-1)?.batchId;
  if (!lastBatch) return [];
  return rows
    .filter((r) => r.batchId === lastBatch)
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
  const fileHint = files.length ? `本批涉及文件：${files.join("、")}。` : "";
  return `${WORKSPACE_SUGGEST_MARKER} 本批业务工具共 ${biz.length} 次调用（${detail}）。${fileHint}`;
}
