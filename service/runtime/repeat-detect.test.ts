import { expect, test } from "bun:test";
import {
  failureSignature,
  repeatHint,
  REPEAT_CALL_LIMIT,
  REPEAT_DUPLICATE_CALLS,
  REPEAT_DUPLICATE_SIGNATURES,
  REPEAT_WINDOW,
} from "./repeat-detect.ts";
import type { ToolIOItem } from "../types.ts";
import { runtimeConfig } from "../config/runtime.ts";

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
    row("local_fs_list", { path: "/tmp" }),
    row("local_fs_list", { path: "/tmp" }),
  ]);
  expect(hint).toContain("local_fs_list");
  expect(hint).toContain("原样重放");
});

test("argument key order does not defeat the fingerprint", () => {
  const hint = repeatHint([
    row("page_recheck", { tabId: 1, text: "hi" }),
    row("page_recheck", { text: "hi", tabId: 1 }),
  ]);
  expect(hint).toBeTruthy();
});

test("different arguments are not treated as a repeat", () => {
  expect(repeatHint([
    row("local_fs_list", { path: "/tmp" }),
    row("local_fs_list", { path: "/var" }),
  ])).toBeUndefined();
});

test("same tool with different arguments is not flagged by the call rule", () => {
  expect(repeatHint([
    row("local_run", { filename: "a.sh" }),
    row("local_run", { filename: "b.sh" }),
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

test("the repeated-fault hint restates the previous failure and names a next step", () => {
  // The point of the upgrade: "you saw this again" is not actionable, the previous
  // message and the tool's own recovery direction are.
  const first = JSON.stringify({
    ok: false,
    faultCode: "file_not_found",
    message: "script a.sh not found under scripts/",
    recovery: "correct_arguments",
    details: { reason: "filename points at a file that does not exist" },
  });
  // Different arguments on purpose: identical ones would be claimed by the call rule
  // first, and this case is about the fault rule restating the previous failure.
  const hint = repeatHint([row("local_run", { filename: "a.sh" }, first), row("local_run", { filename: "b.sh" }, first)]);
  expect(hint).toContain("file_not_found");
  expect(hint).toContain("script a.sh not found");
  expect(hint).toContain("correct_arguments");
  expect(hint).toContain("不要原样重放");
});

test("the repeated-fault hint still fires when the previous failure carries no detail fields", () => {
  const bare = failure("tool_execution_failed", "");
  const hint = repeatHint([row("open_url", { url: "x" }, bare), row("open_url", { url: "y" }, bare)]);
  expect(hint).toContain("faultCode=tool_execution_failed");
});

test("re-cropping the same region counts as a replay because framing keys are ignored", () => {
  const hint = repeatHint([
    row("capture_page", { tabId: 7, mode: "rect", x: 0, y: 0, width: 100, height: 100 }),
    row("capture_page", { tabId: 7, mode: "rect", x: 40, y: 30, width: 100, height: 100 }),
  ]);
  expect(hint).toContain("等价参数");
});

test("the same tool called many times with identical returns is flagged as zero information gain", () => {
  // The tool rule no longer counts calls: a run of the same tool is normal work
  // (file reads, greps). It fires only when the returns collapse, so every shot
  // below carries a different mode (arguments) but the same return text.
  // The rule looks at the last REPEAT_WINDOW rows only, so the REPEAT_DUPLICATE_CALLS
  // shots have to sit at the very end of the array to be counted at all.
  const pads = Math.max(0, REPEAT_WINDOW - REPEAT_DUPLICATE_CALLS);
  const filler = (i: number) => row(`tool.filler${i}`, { tabId: 7 });
  const shots = Array.from({ length: REPEAT_DUPLICATE_CALLS }, (_, i) =>
    row("capture_page", { tabId: 7, mode: `mode${i}` }, '{"ok":false}'),
  );
  const hint = repeatHint([...Array.from({ length: pads }, (_, i) => filler(100 + i)), ...shots]);
  expect(hint).toContain("capture_page");
  expect(hint).toContain("runtime[repeat:tool]");
});

test("many calls to one tool with distinct returns are not flagged", () => {
  // Same tool, same count, but every call produced something new: that is normal
  // exploration, not a mechanical replay.
  const shots = Array.from({ length: REPEAT_DUPLICATE_CALLS }, (_, i) =>
    row("local_fs_grep", { path: `/p${i}` }, `{"ok":true,"matches":${i}}`),
  );
  expect(repeatHint(shots)).toBeUndefined();
});

test("the tool rule stays quiet when the duplicate return count exceeds the threshold", () => {
  const distinct = Array.from({ length: REPEAT_DUPLICATE_SIGNATURES + 1 }, (_, i) =>
    row("local_fs_read", { path: `/p${i}` }, `{"ok":true,"chars":${i * 100}}`),
  );
  const shots = Array.from({ length: REPEAT_DUPLICATE_CALLS }, (_, i) =>
    row("capture_page", { tabId: 7, mode: `mode${i}` }, `{"ok":true,"variant":${i}}`),
  );
  expect(repeatHint([...distinct, ...shots])).toBeUndefined();
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
    { ...row("open_url", { url: "z" }, text), runtimeHints: [first!] },
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
  const gate = row("page_type", { tabId: 1 }, failure("task_gate_required", "需要活动 Task"));
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
  expect(String(REPEAT_DUPLICATE_CALLS)).toBe(String(runtimeConfig.context.repeatDuplicateCalls));
  expect(String(REPEAT_DUPLICATE_SIGNATURES)).toBe(String(runtimeConfig.context.repeatDuplicateSignatures));
});
