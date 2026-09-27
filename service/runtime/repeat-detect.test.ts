import { expect, test } from "bun:test";
import { failureSignature, repeatHint, REPEAT_CALL_LIMIT } from "./repeat-detect.ts";
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

test("successful rows between failures break the consecutive run", () => {
  const text = failure("missing_required", "a");
  expect(repeatHint([
    row("open_url", { url: "x" }, text),
    row("see_page", { tabId: 1 }, '{"ok":true}'),
    row("open_url", { url: "y" }, text),
  ])).toBeUndefined();
});

test("failureSignature reads faultCode from JSON and tolerates non-JSON text", () => {
  expect(failureSignature(row("t", {}, failure("stopped", "x")))).toBe("stopped::x");
  expect(failureSignature(row("t", {}, '{"ok":true}'))).toBeUndefined();
  expect(failureSignature(row("t", {}, 'prefix "faultCode":"boom" suffix'))).toBe("boom::");
});

test("the call rule fires before the error rule for the same pair", () => {
  const text = failure("missing_required", "a");
  const hint = repeatHint([row("open_url", { url: "x" }, text), row("open_url", { url: "x" }, text)]);
  expect(hint).toContain("原样重放");
  expect(hint).not.toContain("faultCode=");
  expect(String(REPEAT_CALL_LIMIT)).toBe("2");
});
