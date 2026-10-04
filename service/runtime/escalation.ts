import { runtimeConfig } from "../config/runtime.ts";
import type { ToolIOItem } from "../types.ts";

// 按返回计数的实质性兜底：有实质性就清零，无就累计，循环往复。
// 30 次连续只读 → 第一次提示；再 30 次（累计 60）仍无实质性 → 第二次提示（仅剩 3 次机会）；
// 63 次仍无 → 最后通牒（给模型，要求立即收口）；66 次仍无 → 直接中断。不再设确认类工具。
export const READ_ONLY_PROMPT = runtimeConfig.context.readOnlyPrompt;
export const READ_ONLY_SECOND = runtimeConfig.context.readOnlySecond;
export const READ_ONLY_GRACE = runtimeConfig.context.readOnlyGrace;
export const READ_ONLY_HARD = runtimeConfig.context.readOnlyHard;
/** 最后通牒线 = 第二次提示后再给 3 次机会。 */
export const READ_ONLY_FINAL = READ_ONLY_SECOND + READ_ONLY_GRACE;
// Live budget hints carry a marker so the loop strips the previous one before re-evaluating,
// keeping exactly one active budget nudge in the window (same lifecycle as observation/reflect nudges).
// interrupt 终止本 turn 而不是提示，所以不带标记；两档 hint 都带标记。
export const BUDGET_NUDGE_MARKER = "runtime: 预算提醒";

export type Escalation =
  | { action: "continue" }
  | { action: "hint"; text: string }
  | { action: "interrupt"; text: string };

/** 只读判定唯一来源：capability metadata 的 readOnly 标记（经 registry 传入）。
 * 名单之外的业务工具一律视为实质性（给模型 credit，避免误杀）。 */

/**
 * 记账/控制类工具：既不算只读累积，也不算实质性清零。
 * 含已删除的 checkContinue / reportProgress（兼容历史 turn 里残留的行）。
 */
export const NEUTRAL_TOOLS = new Set([
  "observation_write", "reflect_write", "reflect_delete",
  "notes_write", "notes_delete",
  "memory_writeConversation", "memory_writeProject", "memory_update", "memory_delete",
  "task_set", "task_update", "task_complete",
  "skill_load", "skill_list", "catalog_add", "list_browser_tools",
  "agent_compress", "page_clear_result",
  "askUser", "finishTurn",
  "checkContinue", "reportProgress",
  "workspace_write",
]);

/** 自上次实质性操作以来的连续只读业务调用数（跳过 NEUTRAL）。 */
export function substantiveStreak(rows: ToolIOItem[], readOnly: Set<string>): number {
  let streak = 0;
  for (const row of rows) {
    if (NEUTRAL_TOOLS.has(row.name)) continue;
    if (readOnly.has(row.name)) {
      streak += 1;
    } else {
      streak = 0;
    }
  }
  return streak;
}

/**
 * 每 turn 按返回计数升级：只读 30 提示一次要实质性操作，再 30 仍无则第二次提示（仅剩 3 次机会），
 * 63 仍无则下最后通牒（给模型，要求立即收口），66 仍无才直接中断。有实质性就清零，循环往复。
 * 只有最后一档是 interrupt（模型已无机会，turn 直接收口）；前三档都是 hint，写进工具返回给模型看。
 */
export function escalate(rows: ToolIOItem[], _lastName: string, readOnly: Set<string>): Escalation {
  const streak = substantiveStreak(rows, readOnly);
  if (streak >= READ_ONLY_HARD) {
    return { action: "interrupt", text: `runtime: 已连续 ${streak} 次工具调用只有读取类操作、无实质性进展，本 turn 结束。请基于已有证据收口，缺关键信息就用 askUser 问一次，别空转。` };
  }
  if (streak >= READ_ONLY_FINAL) {
    return { action: "hint", text: `${BUDGET_NUDGE_MARKER} 已连续 ${streak} 次只有读取类操作，仍无实质性进展，这是最后通牒：立即用 finishTurn 基于已有证据收口，缺关键信息就用 askUser 问一次；再做只读调用本 turn 将直接中断，不会再提醒。` };
  }
  if (streak >= READ_ONLY_SECOND) {
    const remaining = READ_ONLY_SECOND + READ_ONLY_GRACE - streak;
    return { action: "hint", text: `${BUDGET_NUDGE_MARKER} 已连续 ${streak} 次只有读取类操作，仍无实质性进展。仅剩 ${remaining} 次机会：下一次调用必须做实质性操作（点击/填写/写入/执行/断言验收等，只读复查不算），否则本 turn 将直接中断。` };
  }
  if (streak >= READ_ONLY_PROMPT) {
    return { action: "hint", text: `${BUDGET_NUDGE_MARKER} 已连续 ${streak} 次工具返回只有读取类操作，没有实质性进展。请做一次实质性操作（推进任务的点击/填写/写入/执行/断言验收等），而不是继续只读复查；出现一次实质性操作计数即清零。` };
  }
  return { action: "continue" };
}
