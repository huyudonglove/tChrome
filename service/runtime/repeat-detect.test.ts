import { expect, test } from "bun:test";
import { failureSignature, repeatHint, REPEAT_CALL_LIMIT, REPEAT_TOOL_LIMIT, REPEAT_WINDOW } from "./repeat-detect.ts";
import type { ToolIOItem } from "../types.ts";

let seq = 0;
const row = (name: string, args: Record<string, unknown> = {}, text = ""): ToolIOItem => {
  seq += 1;
  return {
    callId: `call_${seq}`,
    name,
    arguments: args,
    turnId: "tn_01",
    return: { stage: "complete", totalChars: text.length, text },
  };
};

const failure = (faultCode: string, message: string): string =>
  JSON.stringify({ ok: false, faultCode, message });

test("a single call never triggers a repeat hint", () => {
  expect(repeatHint([row("see_page", { tabId: 1 })])).toBeUndefined();
});

test("identical tool and identical arguments in a row produces a hint", () => {
  const hint = repeatHint([
    row("local.fs_list", { path: "/tmp" }),
    row("local.fs_list", { path: "/tmp" }),
  ]);
  expect(hint).toContain("local.fs_list");
  expect(hint).toContain("原样重放");
});

test("argument key order does not defeat the fingerprint", () => {
  const hint = repeatHint([
    row("page.recheck", { tabId: 1, text: "hi" }),
    row("page.recheck", { text: "hi", tabId: 1 }),
  ]);
  expect(hint).toBeTruthy();
});

test("different arguments are not treated as a repeat", () => {
  expect(repeatHint([
    row("local.fs_list", { path: "/tmp" }),
    row("local.fs_list", { path: "/var" }),
  ])).toBeUndefined();
});

test("same tool with different arguments is not flagged by the call rule", () => {
  expect(repeatHint([
    row("local.run", { filename: "a.sh" }),
    row("local.run", { filename: "b.sh" }),
  ])).toBeUndefined();
});

test("two consecutive identical failures produce an error hint", () => {
  const text = failure("missing_required", "runtime: 缺少必填参数。");
  // Different arguments, so the call rule does not apply; only the failure rule should fire.
  const hint = repeatHint([row("open_url", { url: "x" }, text), row("open_url", { url: "y" }, text)]);
  expect(hint).toContain("同一个错误");
  expect(hint).toContain("missing_required");
});

test("different fault codes do not trigger the error hint", () => {
  expect(repeatHint([
    row("open_url", { url: "x" }, failure("missing_required", "a")),
    row("open_url", { url: "y" }, failure("wrong_type", "b")),
  ])).toBeUndefined();
});

test("an interleaved success no longer hides a repeated failure", () => {
  // Sliding window: a successful row between two failures no longer breaks the run.
  const text = failure("missing_required", "a");
  const hint = repeatHint([
    row("open_url", { url: "x" }, text),
    row("see_page", { tabId: 1 }, '{"ok":true}'),
    row("open_url", { url: "y" }, text),
  ]);
  expect(hint).toContain("同一个错误");
  expect(hint).toContain("missing_required");
});

test("the same faultCode with different messages still counts as one repeated failure", () => {
  const hint = repeatHint([
    row("open_url", { url: "x" }, failure("tool_execution_failed", "request br_448 was claimed")),
    row("see_page", { tabId: 1 }, '{"ok":true}'),
    row("open_url", { url: "y" }, failure("tool_execution_failed", "request br_451 was claimed")),
  ]);
  expect(hint).toContain("faultCode=tool_execution_failed");
});

test("re-cropping the same region counts as a replay because framing keys are ignored", () => {
  const hint = repeatHint([
    row("capture_page", { tabId: 7, mode: "rect", x: 0, y: 0, width: 100, height: 100 }),
    row("capture_page", { tabId: 7, mode: "rect", x: 40, y: 30, width: 100, height: 100 }),
  ]);
  expect(hint).toContain("等价参数");
});

test("one tool called many times in the window is flagged even with different arguments", () => {
  // Non-framing arguments differ (mode), so the call rule stays quiet and the tool rule fires.
  const hint = repeatHint([
    row("capture_page", { tabId: 7, mode: "viewport" }),
    row("page.get_summary", { tabId: 7 }),
    row("capture_page", { tabId: 7, mode: "rect", x: 1, y: 2, width: 10, height: 10 }),
    row("page.assert", { tabId: 7, text: "ok" }),
    row("capture_page", { tabId: 7, mode: "full_page" }),
    row("page.recheck", { tabId: 7, text: "ok" }),
    row("capture_page", { tabId: 7, mode: "som" }),
  ]);
  expect(hint).toContain("capture_page");
  expect(hint).toContain("runtime[repeat:tool]");
});

test("a rule fires at most once per turn", () => {
  const text = failure("missing_required", "a");
  const first = repeatHint([
    row("open_url", { url: "x" }, text),
    row("open_url", { url: "y" }, text),
  ]);
  expect(first).toBeTruthy();
  const afterFired = [
    row("open_url", { url: "x" }, text),
    row("open_url", { url: "y" }, text),
    { ...row("open_url", { url: "z" }, text), return: { stage: "complete" as const, totalChars: 0, text: `${text}\n\n${first}` } },
  ];
  expect(repeatHint(afterFired)).toBeUndefined();
});

test("failureSignature reads faultCode from JSON and tolerates non-JSON text", () => {
  expect(failureSignature(row("t", {}, failure("stopped", "x")))).toBe("stopped::x");
  expect(failureSignature(row("t", {}, '{"ok":true}'))).toBeUndefined();
  expect(failureSignature(row("t", {}, 'prefix "faultCode":"boom" suffix'))).toBe("boom::");
});

test("a diagnosable fault never seen in history asks to be written down once", () => {
  const failed = row("capture_page", { tabId: 1 }, failure("executor_version_mismatch", "版本不一致"));
  const fresh = repeatHint([failed]);
  expect(fresh).toContain("first-fault:memory");
  expect(fresh).toContain("executor_version_mismatch");
  // a later occurrence in the same turn is a distinct call, so it counts as "seen before"
  const again = row("capture_page", { tabId: 1 }, failure("executor_version_mismatch", "版本不一致"));
  expect(repeatHint([failed, again])).not.toContain("first-fault:memory");
  // an earlier occurrence anywhere in the conversation suppresses it
  const earlier = row("capture_page", { tabId: 2 }, failure("executor_version_mismatch", "版本不一致"));
  expect(repeatHint([failed], [earlier, failed])).toBeUndefined();
  // design-internal failures are not diagnosable and must not nag
  const gate = row("page.type", { tabId: 1 }, failure("task_gate_required", "需要活动 Task"));
  expect(repeatHint([gate])).toBeUndefined();
});

test("the call rule fires before the error rule for the same pair", () => {
  const text = failure("missing_required", "a");
  const hint = repeatHint([row("open_url", { url: "x" }, text), row("open_url", { url: "x" }, text)]);
  expect(hint).toContain("等价参数");
  expect(hint).toContain("原样重放");
  expect(hint).not.toContain("faultCode=");
  expect(String(REPEAT_CALL_LIMIT)).toBe("2");
  expect(String(REPEAT_WINDOW)).toBe("8");
  expect(String(REPEAT_TOOL_LIMIT)).toBe("4");
});
