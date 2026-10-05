import { expect, test } from "bun:test";
import { toolHistoryView } from "./tools.ts";
import type { ToolIOItem } from "../../types.ts";

const row = (name: string, args: Record<string, unknown>, text = '{"ok":true}'): ToolIOItem => ({
  callId: "call_01",
  batchId: "batch_01",
  name,
  arguments: args,
  turnId: "tn_01",
  return: { stage: "complete", totalChars: text.length, text },
});

test("small args ride along with the call", () => {
  const [view] = toolHistoryView([
    row("local_fs_read", { reason: "读鉴权", items: [{ path: "src/auth.ts", startLine: 1 }] }),
  ]);
  expect(view).toMatchObject({
    callId: "call_01",
    name: "local_fs_read",
    args: { reason: "读鉴权", items: [{ path: "src/auth.ts", startLine: 1 }] },
  });
});

test("oversized args keep file paths only", () => {
  const [view] = toolHistoryView([
    row("script_write", { reason: "写脚本", filename: "audit.mjs", code: "x".repeat(20000) }),
  ]);
  expect(view).toMatchObject({ args: { files: ["audit.mjs"] } });
  expect(JSON.stringify(view)).not.toContain("x".repeat(100));
});

test("oversized args without files are omitted", () => {
  const [view] = toolHistoryView([
    row("page_fill", { reason: "填表", text: "y".repeat(20000) }),
  ]);
  expect(view).not.toHaveProperty("args");
});

test("bookkeeping pointers and observation calls carry no args", () => {
  const [task] = toolHistoryView([
    row("task_set", { title: "修", items: [{ text: "改代码" }] }, '{"ok":true,"count":1}'),
  ]);
  expect(task).not.toHaveProperty("args");
  const [obs] = toolHistoryView(
    [row("observation_write", { type: "local_fs_read", result: "token" })],
    [{ id: "page_01", turnId: "tn_01", observedAt: "now", callId: "call_01", type: "local_fs_read", result: "token" }],
  );
  expect(obs).not.toHaveProperty("args");
  expect(obs).toMatchObject({ return: { result: { observationId: "page_01" } } });
});

test("query pointer keeps its query args", () => {
  const [view] = toolHistoryView([
    row("context_query", { reason: "查", sumId: "sum_01", module: "workspace", intent: "鉴权结论", file: "auth.ts" },
      '{"ok":true,"status":"complete","sumId":"sum_01","module":"workspace","intent":"鉴权结论","records":[]}'),
  ]);
  expect(view).toMatchObject({
    args: { sumId: "sum_01", module: "workspace", intent: "鉴权结论", file: "auth.ts" },
  });
});
