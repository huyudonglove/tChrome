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

test("once checkContinue exists, total gates yield like the old same-tool gates", () => {
  const many = Array.from({ length: 65 }, (_, i) => row(`tool_${i}`));
  const withCheck = [row(CHECK_TOOL, { cont: true }), ...many];
  // 与旧单工具规则一致：出现过 checkContinue 后，总次数门禁不再触发，交给升级链。
  expect(escalate(withCheck, many.at(-1)!.name).action).toBe("continue");

  const atPrompt = Array.from({ length: SAME_TOOL_PROMPT }, (_, i) => row(`tool_${i}`));
  const checked = [row(CHECK_TOOL, { cont: true }), ...atPrompt];
  expect(escalate(checked, atPrompt.at(-1)!.name).action).toBe("continue");

  // 连续 3 次 check 后仍进入 reportProgress 链
  const checks3 = Array.from({ length: 3 }, () => row(CHECK_TOOL, { cont: true }));
  expect(escalate([...checks3, ...many], many.at(-1)!.name)).toMatchObject({
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
