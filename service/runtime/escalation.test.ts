import { expect, test } from "bun:test";
import {
  escalate,
  BUDGET_NUDGE_MARKER,
  CHECK_TOOL,
  PROGRESS_TOOL,
  SAME_TOOL_PROMPT,
} from "./escalation.ts";
import type { ToolIOItem } from "../types.ts";

const row = (name: string, args: Record<string, unknown> = {}): ToolIOItem => ({
  callId: `call_${name}_${Math.random().toString(36).slice(2, 8)}`,
  name,
  arguments: args,
  turnId: "tn_01",
  return: { stage: "complete", totalChars: 0, text: "" },
});

const rows = (...names: string[]): ToolIOItem[] => names.map((name) => row(name));

test("checkContinue and reportProgress do not inflate the total", () => {
  const business = Array.from({ length: SAME_TOOL_PROMPT - 1 }, (_, i) => row(`tool_${i}`));
  const withMeta = [
    ...business,
    row(CHECK_TOOL, { cont: true }),
    row(PROGRESS_TOOL, { text: "进度" }),
  ];
  expect(escalate(withMeta, PROGRESS_TOOL).action).toBe("continue");
});

test("live budget hints carry the strip marker", () => {
  const atPrompt = Array.from({ length: SAME_TOOL_PROMPT }, (_, i) => row(`tool_${i}`));
  const promptHint = escalate(atPrompt, atPrompt.at(-1)!.name) as { action: string; text: string };
  expect(promptHint.action).toBe("hint");
  expect(promptHint.text).toContain(BUDGET_NUDGE_MARKER);

  // 链级活提示（进度/求助/收口）同样带标记，否则旧行不会被 loop 的 strip 抹掉。
  const checks3 = Array.from({ length: 3 }, () => row(CHECK_TOOL, { cont: true }));
  const few = Array.from({ length: 3 }, (_, i) => row(`tool_${i}`));
  const progressHint = escalate([...checks3, ...few], few.at(-1)!.name) as { text: string };
  expect(progressHint.text).toContain(BUDGET_NUDGE_MARKER);

  const reports3 = [
    ...checks3,
    ...Array.from({ length: 3 }, () => row(PROGRESS_TOOL, { text: "进度" })),
    row("tool_probe"),
  ];
  const askHint = escalate(reports3, "tool_probe") as { text: string };
  expect(askHint.text).toContain(BUDGET_NUDGE_MARKER);

  // 预算段没有终止档：硬阈值也是活提示，照样带标记（loop 会 strip 掉上一条）。
  const many = Array.from({ length: 65 }, (_, i) => row(`tool_${i}`));
  const hardHint = escalate(many, many.at(-1)!.name) as { action: string; text: string };
  expect(hardHint.action).toBe("hint");
  expect(hardHint.text).toContain(BUDGET_NUDGE_MARKER);
  expect(hardHint.text).toContain("observation_write");
});

test("checkContinue resets the budget segment instead of exempting the whole turn", () => {
  const many = Array.from({ length: 65 }, (_, i) => row(`tool_${i}`));
  // 分段计数：刚调过 checkContinue 时预算重置，65 次调用重新逼近强提示档。
  const withCheck = [row(CHECK_TOOL, { cont: true }), ...many];
  expect(escalate(withCheck, many.at(-1)!.name).action).toBe("hint");

  // 调过 checkContinue 后再跑满一个 prompt 段，应重新提示（这是本次修复的行为）。
  const atPrompt = Array.from({ length: SAME_TOOL_PROMPT }, (_, i) => row(`tool_${i}`));
  const checked = [row(CHECK_TOOL, { cont: true }), ...atPrompt];
  expect(escalate(checked, atPrompt.at(-1)!.name)).toMatchObject({
    action: "hint",
    text: expect.stringContaining("checkContinue"),
  });

  // 从未调过 checkContinue 时门槛同样照常触发。
  expect(escalate(atPrompt, atPrompt.at(-1)!.name).action).toBe("hint");
  expect(escalate(many, many.at(-1)!.name).action).toBe("hint");

  // 连续 3 次 check 后仍进入 reportProgress 链。
  // 段内业务调用须低于强提示门槛，否则会先被硬档 hint 截断。
  const checks3 = Array.from({ length: 3 }, () => row(CHECK_TOOL, { cont: true }));
  const few = Array.from({ length: 3 }, (_, i) => row(`tool_${i}`));
  expect(escalate([...checks3, ...few], few.at(-1)!.name)).toMatchObject({
    action: "hint",
    text: expect.stringContaining("reportProgress"),
  });
});

test("checkContinue cont=false interrupts before any counting", () => {
  const many = Array.from({ length: 65 }, (_, i) => row(`tool_${i}`));
  const withFalse = [...many, row(CHECK_TOOL, { cont: false })];
  expect(escalate(withFalse, CHECK_TOOL).action).toBe("interrupt");
});

test("progress chain hands off check -> report -> askUser -> finishTurn", () => {
  const checks = Array.from({ length: 3 }, () => row(CHECK_TOOL, { cont: true }));
  expect(escalate(checks, CHECK_TOOL)).toMatchObject({ action: "hint", text: expect.stringContaining("reportProgress") });

  const reports = Array.from({ length: 3 }, (_, i) => row(PROGRESS_TOOL, { text: `p${i}` }));
  expect(escalate(reports, PROGRESS_TOOL)).toMatchObject({ action: "hint", text: expect.stringContaining("askUser") });

  const asked = [row("askUser", { question: "?" })];
  expect(escalate(asked, "askUser").action).toBe("continue");
  const after3 = [row("askUser", { question: "?" }), ...rows("a", "b", "c")];
  expect(escalate(after3, "c")).toMatchObject({ action: "hint", text: expect.stringContaining("finishTurn") });
  // 空转再久也只是收口提示，runtime 不替我结束本 turn。
  const after6 = [row("askUser", { question: "?" }), ...rows("a", "b", "c", "d", "e", "f")];
  expect(escalate(after6, "f")).toMatchObject({ action: "hint", text: expect.stringContaining("finishTurn") });
});
