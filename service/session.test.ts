import { errorMessage } from "../shared/errors.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, emptyLedger, loadEvents, saveLedger, saveTurn, sessionView } from "./runtime/store.ts";
import type { LogEvent, Task, Turn, TurnStopReason } from "./types.ts";
import { emptySessionView, projectSessionView } from "./presentation/session-view.ts";

const makeTurn = (output: TurnStopReason | null): Turn => ({   turnId: "tn_01", conversationId: "cv_01", status: output ? "completed" : "inferring",
  createdAt: "2026-09-07T00:00:00.000Z", completedAt: null,
  input: { id: "input_fixture", text: "查看当前页面", submittedAt: "2026-09-07T00:00:00.000Z" },
  assembled: { baseToolsIds: [], toolIds: [],
     conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], currentPage: null, observations: [], workspace: [], currentTabs: { ok: true, windows: [] } },
  stopReason: output,
  // session view reads stopReason.text for panel display
});

const outputs: { stopReason: TurnStopReason; expected: string }[] = [
  { stopReason: { kind: "error", faultCode: "missing_required", toolName: "click", detail: "click missing required: tabId; data/text must be string" }, expected: "工具调用缺少必填参数。" },
  { stopReason: { kind: "reply", text: "这是商品详情页。" }, expected: "这是商品详情页。" },
  { stopReason: { kind: "ask", question: "选择哪个商品？" }, expected: "选择哪个商品？" },
  { stopReason: { kind: "interrupted", initiatedBy: "user" }, expected: "已中断（用户）" },
  { stopReason: { kind: "error", faultCode: "provider_error" }, expected: errorMessage("provider_error", "user") },
  { stopReason: { kind: "error", faultCode: "provider_error", detail: "status=400; 400 Your request was rejected by the upstream safety system (promptFeedback.blockReason=OTHER)" }, expected: errorMessage("provider_error", "user") },
  { stopReason: { kind: "error", faultCode: "max_outbounds" }, expected: "本轮已达到执行次数上限，任务还没有完成。" },
];

test("session compression activity follows the active turn and clears after completion or failure", () => {
  const ledger = emptyLedger("cv_01");
  ledger.status = "running";
  ledger.active = { turnId: "tn_01" };
  const events: LogEvent[] = [];
  const view = () => projectSessionView({ ledger, events, turns: [makeTurn(null)] });
  const emit = (kind: string, data: Record<string, unknown> = {}, turnId = "tn_01") => {
    events.push({ at: "2026-09-07T00:00:00.000Z", kind, turnId, data });
  };
  emit("compress-start", {}, "tn_old");
  expect(view().activity).toBeNull();
  emit("compress-start");
  expect(view().activity).toEqual({ kind: "compressing", source: "runtime", phase: null, completed: 0, total: null, fold: null });
  emit("compress-progress", { completed: 0, total: 5 });
  expect(view().activity).toEqual({ kind: "compressing", source: "runtime", phase: null, completed: 0, total: 5, fold: null });
  emit("compress-progress", { merged: 3, level: 1, turnIds: 7 });
  expect(view().activity).toEqual({ kind: "compressing", source: "runtime", phase: null, completed: 0, total: 5, fold: { merged: 3, level: 1, turnIds: 7 } });
  emit("compress-error");
  emit("compress-start", { source: "agent" });
  expect(view().activity).toEqual({ kind: "compressing", source: "agent", phase: null, completed: 0, total: null, fold: null });
  emit("compress-phase", { phase: "history" });
  emit("compress-progress", { completed: 2, total: 5, turnId: "tn_02" });
  expect(view().activity).toEqual({ kind: "compressing", source: "agent", phase: "history", completed: 2, total: 5, fold: null });
  emit("compress", {}, "tn_old");
  expect(view().activity?.completed).toBe(2);
  emit("compress");
  expect(view().activity).toBeNull();
  emit("compress-start");
  emit("compress-progress", { completed: 1, total: 2 });
  emit("compress-error");
  expect(view().activity).toBeNull();
  emit("compress-phase", { phase: "history" });
  expect(view().activity).toBeNull();
  emit("compress-start");
  for (const status of ["idle", "waiting_human", "paused", "failed"] as const) {
    ledger.status = status;
    expect(view().activity).toBeNull();
  }
  ledger.status = "running";
  ledger.active = { turnId: "tn_02" };
  expect(view().activity).toBeNull();
  ledger.active = null;
  expect(view().activity).toBeNull();
  expect(emptySessionView().activity).toBeNull();
});

test.each(outputs)("session uses authoritative $stopReason.kind and preserves diagnostic logs", ({ stopReason, expected }) => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-session-output-"));
  try {
    const ledger = emptyLedger("cv_01");
    ledger.turnIds = ["tn_01"];
    saveLedger(dir, ledger);
    saveTurn(dir, makeTurn(stopReason));
    appendEvent(dir, "cv_01", { kind: "provider-response", turnId: "tn_01", data: {
      content: "seen\nINTERNAL_PAGE_DATA\nreason\nINTERNAL_REASON\naction\nINTERMEDIATE_ACTION",
    } });
    appendEvent(dir, "cv_01", { kind: "tool", turnId: "tn_01", data: {
      name: "page_get_summary", arguments: { reason: "读取页面摘要" },
      return: { text: '{"secret":"RAW_TOOL_RETURN"}' },
    } });
    const eventsBefore = loadEvents(dir, "cv_01");
    const view = sessionView(dir, "cv_01");
    expect(view.messages).toEqual([
      { turnId: "tn_01", role: "user", text: "查看当前页面" },
      { turnId: "tn_01", role: "tool", name: "page_get_summary", text: "读取页面摘要" },
      { turnId: "tn_01", role: "assistant", text: expected },
    ]);
    expect(JSON.stringify(view)).not.toContain("INTERNAL_PAGE_DATA");
    expect(JSON.stringify(view)).not.toContain("INTERNAL_REASON");
    expect(JSON.stringify(view)).not.toContain("INTERMEDIATE_ACTION");
    expect(JSON.stringify(view)).not.toContain("RAW_TOOL_RETURN");
    expect(loadEvents(dir, "cv_01")).toEqual(eventsBefore);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("running toolIO and live queue retain reasons without raw returns", () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-session-progress-"));
  try {
    const ledger = emptyLedger("cv_01");
    ledger.turnIds = ["tn_01"];
    ledger.status = "running";
    ledger.active = { turnId: "tn_01" };
    ledger.toolIO = [{ turnId: "tn_01", callId: "old", name: "page_get_summary", arguments: {},
      return: { stage: "complete", totalChars: 18, text: '{"data":"PRIVATE"}' } }];
    ledger.liveTools = [{ callId: "live", name: "page_click", reason: "点击提交按钮" }];
    ledger.toolQueue = [{ callId: "queued", name: "page_type", arguments: { reason: "很长的进度说明".repeat(30) } }];
    saveLedger(dir, ledger);
    saveTurn(dir, makeTurn(null));
    appendEvent(dir, "cv_01", { kind: "provider-response", turnId: "tn_01", data: { content: "seen\nPRIVATE" } });
    const view = sessionView(dir, "cv_01");
    expect(view.messages.map((row) => row.role)).toEqual(["user", "tool", "tool", "tool"]);
    expect(view.messages[1]?.text).toBe("工具调用已结束");
    expect(view.messages[2]).toMatchObject({ name: "page_click", text: "点击提交按钮", live: true });
    expect(view.messages[3]?.text).toBe("很长的进度说明".repeat(30));
    expect(JSON.stringify(view)).not.toContain("PRIVATE");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("tool messages fall back to ledger.toolIO when events carry no tool rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-session-toolio-fallback-"));
  try {
    const ledger = emptyLedger("cv_01");
    ledger.turnIds = ["tn_01"];
    ledger.toolIO = [{ turnId: "tn_01", callId: "call_01", name: "page_get_summary", arguments: { reason: "读取页面摘要" },
      return: { stage: "complete", totalChars: 26, text: '{"data":"RAW_TOOL_RETURN"}' } }];
    saveLedger(dir, ledger);
    saveTurn(dir, makeTurn({ kind: "reply", text: "完成" }));
    const view = sessionView(dir, "cv_01");
    expect(view.messages).toEqual([
      { turnId: "tn_01", role: "user", text: "查看当前页面" },
      { turnId: "tn_01", role: "tool", name: "page_get_summary", text: "读取页面摘要" },
      { turnId: "tn_01", role: "assistant", text: "完成" },
    ]);
    expect(JSON.stringify(view)).not.toContain("RAW_TOOL_RETURN");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("task panel is a live view: only an active plan is shown, and the pointer surviving completion is not a leak", () => {
  const ledger = emptyLedger("cv_01");
  ledger.status = "running";
  ledger.active = { turnId: "tn_01" };
  const plan = (status: Task["status"]): Task => ({
    id: "task_09", title: "解耦 Task 生命周期", status,
    items: [{ id: "item_01", index: 1, text: "改门禁", status: status === "active" ? "doing" : "done", createdAt: "2026-09-07T00:00:00.000Z" }],
    createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z",
  });
  const view = () => projectSessionView({ ledger, events: [], turns: [makeTurn(null)] });

  // Pointer still points at a completed plan: panel hides it, and attribution pointer is not leaked as active.
  ledger.tasks = [plan("completed")];
  ledger.activeTaskId = "task_09";
  expect(view().task).toMatchObject({ activeTaskId: null, activeTaskItemId: null, task: null });

  // Paused is equally not live.
  ledger.tasks = [plan("paused")];
  expect(view().task).toMatchObject({ activeTaskId: null, activeTaskItemId: null, task: null });

  // Only active renders, and the item pointer rides along.
  ledger.tasks = [plan("active")];
  ledger.activeTaskItemId = "item_01";
  expect(view().task).toMatchObject({ activeTaskId: "task_09", activeTaskItemId: "item_01" });
  expect(view().task?.task).toMatchObject({ id: "task_09", status: "active" });
});
