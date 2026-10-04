import { runtimeConfig } from "../config/runtime.ts";
import type { ToolIOItem } from "../types.ts";

export const CHECK_TOOL = "checkContinue";
export const PROGRESS_TOOL = "reportProgress";
// 预算重置点：checkContinue、进度汇报、写观察、写反思，都是「我确认过当前状态」的显式动作。
// runtime 的目的是让我顺利跑完而不是替我收口，所以只要留下了可续跑的检查点就重置预算段。
const RESET_TOOLS = new Set([CHECK_TOOL, PROGRESS_TOOL, "observation_write", "reflect_write"]);
// Per-turn tool-call budget comes from gates (prompt threshold / hard stop).
export const SAME_TOOL_PROMPT = runtimeConfig.context.checkContinuePrompt;
export const SAME_TOOL_HARD = runtimeConfig.context.checkContinueHard;
export const CHECK_PROMPTS = 3;
export const PROGRESS_LIMIT = 3;
export const ASK_THEN_ROUNDS = 3;
export const FINISH_HINTS = 3;
// Live budget hints carry a marker so the loop strips the previous one before re-evaluating,
// keeping exactly one active budget nudge in the window (same lifecycle as observation/reflect nudges).
// interrupt 终止本 turn 而不是提示，所以不带标记；两档 hint（含强提示）都带标记。
export const BUDGET_NUDGE_MARKER = "runtime: 预算提醒";

export type Escalation =
  | { action: "continue" }
  | { action: "hint"; text: string }
  | { action: "interrupt"; text: string };

/**
 * 每 turn 计数升级链：提示/强提示门槛读 gates.context（checkContinuePrompt / checkContinueHard），其余链级数字不变。
 * 计数为「自上次 checkContinue 以来的业务调用数」（不含 checkContinue / reportProgress），
 * 避免轮换工具名绕过单工具门禁；分段计数则避免调过一次就豁免掉本轮剩余全部预算。
 * 链：段内次数达 checkContinuePrompt 提示确认预算，达 checkContinueHard 发强提示（仍不结束本 turn）；
 * check×3→进度；进度×3→askUser 1 次；其后 3 轮建议 finishTurn，再 3 轮升级为强提示。
 * 本文件不产生终止动作：任何档位都能靠确认或检查点重置，runtime 不替模型关闭本轮。
 */
export function escalate(rows: ToolIOItem[], lastName: string): Escalation {
  const turnRows = rows;
  const checks = turnRows.filter((row) => row.name === CHECK_TOOL);
  const checksTrue = checks.filter((row) => (row.arguments as { cont?: unknown }).cont === true).length;
  const checksFalse = checks.some((row) => (row.arguments as { cont?: unknown }).cont === false);
  if (checksFalse) return { action: "interrupt", text: "runtime: checkContinue(cont=false) 已中断本 turn。" };

  const reports = turnRows.filter((row) => row.name === PROGRESS_TOOL).length;
  const asks = turnRows.filter((row) => row.name === "askUser").length;
  const finishes = turnRows.filter((row) => row.name === "finishTurn").length;
  // 预算计数：只数「自上次确认预算以来」的业务调用（重置点工具本身不计入）。
  // 分段而非整轮累计——确认的语义是「我看过状态了，继续」，
  // 确认一次或落一次检查点就重开一段，而不是让一个长轮一路数到顶再被硬拦。
  const lastResetIndex = turnRows.reduce((last, row, i) => (RESET_TOOLS.has(row.name) ? i : last), -1);
  const sinceCheckRows = lastResetIndex < 0 ? turnRows : turnRows.slice(lastResetIndex + 1);
  const total = sinceCheckRows.filter((row) => !RESET_TOOLS.has(row.name)).length;

  if (total >= SAME_TOOL_HARD) {
    return { action: "hint", text: `${BUDGET_NUDGE_MARKER} 距上次确认预算已调用 ${total} 次工具。这一段已经很长了：先用 observation_write 写阶段小结（当前状态／已确认／未验证）或 reflect_write 记判断变化来重置预算段，或直接用 finishTurn 收口。runtime 不会替你结束本 turn。` };
  }
  if (total >= SAME_TOOL_PROMPT) {
    return { action: "hint", text: `${BUDGET_NUDGE_MARKER} 距上次确认预算已调用 ${total} 次工具。请调用 checkContinue(cont=true) 继续或 cont=false 中断；checkContinue、进度汇报、observation_write、reflect_write 都会重置这段预算。` };
  }
  if (checksTrue >= CHECK_PROMPTS && !reports) {
    return { action: "hint", text: `${BUDGET_NUDGE_MARKER} checkContinue 已确认 3 次仍继续。请调用 reportProgress 汇报当前进度（做了什么、卡点、下一步）。` };
  }
  if (reports >= PROGRESS_LIMIT && !asks) {
    return { action: "hint", text: `${BUDGET_NUDGE_MARKER} 已汇报 3 次进度仍未完成。请调用 askUser 向用户求助。` };
  }
  if (asks >= 1 && !finishes) {
    const afterAsk = turnRows.slice(turnRows.findIndex((row) => row.name === "askUser") + 1).length;
    if (afterAsk >= ASK_THEN_ROUNDS + FINISH_HINTS) {
      return { action: "hint", text: `${BUDGET_NUDGE_MARKER} 询问用户后已 ${afterAsk} 轮仍未收口。请基于现有证据用 finishTurn 收口；若还差关键信息就再用 askUser 问一次，别空转。` };
    }
    if (afterAsk >= ASK_THEN_ROUNDS) {
      return { action: "hint", text: `${BUDGET_NUDGE_MARKER} 请基于现有证据用 finishTurn 收口；继续空转将结束本 turn。` };
    }
  }
  return { action: "continue" };
}
