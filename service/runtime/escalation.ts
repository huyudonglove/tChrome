import type { ToolIOItem } from "./types.ts";

export const CHECK_TOOL = "checkContinue";
export const PROGRESS_TOOL = "reportProgress";
export const SAME_TOOL_PROMPT = 20;
export const SAME_TOOL_HARD = 60;
export const CHECK_PROMPTS = 3;
export const PROGRESS_LIMIT = 3;
export const ASK_THEN_ROUNDS = 3;
export const FINISH_HINTS = 3;

export type Escalation =
  | { action: "continue" }
  | { action: "hint"; text: string }
  | { action: "force_end"; text: string }
  | { action: "interrupt"; text: string };

/** 每 turn 计数升级链：同工具 20 提示 checkContinue，60 强制收口；check×3→进度；进度×3→askUser 1 次；其后 3 轮建议 finishTurn，再 3 次强制结束。 */
export function escalate(rows: ToolIOItem[], lastName: string): Escalation {
  const turnRows = rows;
  const checks = turnRows.filter((row) => row.name === CHECK_TOOL);
  const checksTrue = checks.filter((row) => (row.arguments as { cont?: unknown }).cont === true).length;
  const checksFalse = checks.some((row) => (row.arguments as { cont?: unknown }).cont === false);
  if (checksFalse) return { action: "interrupt", text: "runtime: checkContinue(cont=false) 已中断本 turn。" };

  const reports = turnRows.filter((row) => row.name === PROGRESS_TOOL).length;
  const asks = turnRows.filter((row) => row.name === "askUser").length;
  const finishes = turnRows.filter((row) => row.name === "finishTurn").length;
  const same = lastName === CHECK_TOOL || lastName === PROGRESS_TOOL
    ? 0
    : turnRows.filter((row) => row.name === lastName).length;

  if (same >= SAME_TOOL_HARD && !checks.length) {
    return { action: "force_end", text: `runtime: ${lastName} 已执行 ${same} 次仍未调用 checkContinue，本 turn 结束。` };
  }
  if (same >= SAME_TOOL_PROMPT && !checks.length) {
    return { action: "hint", text: `runtime: ${lastName} 本轮已 ${same} 次。请调用 checkContinue(cont=true) 继续或 cont=false 中断；${SAME_TOOL_HARD} 次仍未调用将结束本 turn。` };
  }
  if (checksTrue >= CHECK_PROMPTS && !reports) {
    return { action: "hint", text: "runtime: checkContinue 已确认 3 次仍继续。请调用 reportProgress 汇报当前进度（做了什么、卡点、下一步）。" };
  }
  if (reports >= PROGRESS_LIMIT && !asks) {
    return { action: "hint", text: "runtime: 已汇报 3 次进度仍未完成。请调用 askUser 向用户求助。" };
  }
  if (asks >= 1 && !finishes) {
    const afterAsk = turnRows.slice(turnRows.findIndex((row) => row.name === "askUser") + 1).length;
    if (afterAsk >= ASK_THEN_ROUNDS + FINISH_HINTS) {
      return { action: "force_end", text: "runtime: 询问用户后仍未收口，本 turn 结束。" };
    }
    if (afterAsk >= ASK_THEN_ROUNDS) {
      return { action: "hint", text: "runtime: 请基于现有证据用 finishTurn 收口；继续空转将结束本 turn。" };
    }
  }
  return { action: "continue" };
}
