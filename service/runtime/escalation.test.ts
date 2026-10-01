import { expect, test } from "bun:test";
import {
  escalate,
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

test("checkContinue resets the budget segment instead of exempting the whole turn", () => {
  const many = Array.from({ length: 65 }, (_, i) => row(`tool_${i}`));
  // 分段计数：刚调过 checkContinue 时预算重置，65 次调用重新逼近硬收口。
  const withCheck = [row(CHECK_TOOL, { cont: true }), ...many];
  expect(escalate(withCheck, many.at(-1)!.name).action).toBe("force_end");

  // 调过 checkContinue 后再跑满一个 prompt 段，应重新提示（这是本次修复的行为）。
  const atPrompt = Array.from({ length: SAME_TOOL_PROMPT }, (_, i) => row(`tool_${i}`));
  const checked = [row(CHECK_TOOL, { cont: true }), ...atPrompt];
  expect(escalate(checked, atPrompt.at(-1)!.name)).toMatchObject({
    action: "hint",
    text: expect.stringContaining("checkContinue"),
  });

  // 从未调过 checkContinue 时门槛同样照常触发。
  expect(escalate(atPrompt, atPrompt.at(-1)!.name).action).toBe("hint");
  expect(escalate(many, many.at(-1)!.name).action).toBe("force_end");

  // 连续 3 次 check 后仍进入 reportProgress 链。
  // 段内业务调用须低于硬收口门槛，否则会先被 force_end 截断。
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
  const after6 = [row("askUser", { question: "?" }), ...rows("a", "b", "c", "d", "e", "f")];
  expect(escalate(after6, "f").action).toBe("force_end");
});
