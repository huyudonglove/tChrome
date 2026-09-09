import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, emptyLedger, loadEvents, saveLedger, saveTurn, sessionView } from "./runtime/store.ts";
import type { Turn, TurnOutput } from "./types.ts";

const makeTurn = (output: TurnOutput | null): Turn => ({
  turnId: "tn_01", conversationId: "cv_01", status: output ? "completed" : "inferring",
  createdAt: "2026-09-07T00:00:00.000Z", completedAt: null,
  input: { text: "查看当前页面", submittedAt: "2026-09-07T00:00:00.000Z" },
  assembled: { baseToolsIds: [], toolIds: [],
    turnMemoryIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], currentPage: null, pageObservedHistory: [], currentTab: null },
  output,
});

const outputs: { output: TurnOutput; expected: string }[] = [
  { output: { kind: "reply", text: "这是商品详情页。" }, expected: "这是商品详情页。" },
  { output: { kind: "ask", question: "选择哪个商品？" }, expected: "选择哪个商品？" },
  { output: { kind: "error", faultCode: "stopped" }, expected: "已停止" },
  { output: { kind: "error", faultCode: "provider_error" }, expected: "模型服务暂时没有正常响应，本轮未完成。请稍后重试。" },
  { output: { kind: "error", faultCode: "max_outbounds" }, expected: "本轮已达到执行次数上限，任务还没有完成。你可以缩小任务范围，或让我继续处理剩余部分。" },
];

test.each(outputs)("session uses authoritative $output.kind and preserves diagnostic logs", ({ output, expected }) => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-session-output-"));
  try {
    const ledger = emptyLedger("cv_01");
    ledger.turnIds = ["tn_01"];
    saveLedger(dir, ledger);
    saveTurn(dir, makeTurn(output));
    appendEvent(dir, "cv_01", { kind: "provider-response", turnId: "tn_01", data: {
      content: "seen\nINTERNAL_PAGE_DATA\nreason\nINTERNAL_REASON\naction\nINTERMEDIATE_ACTION",
    } });
    appendEvent(dir, "cv_01", { kind: "tool", turnId: "tn_01", data: {
      name: "page.get_summary", arguments: { reason: "读取页面摘要" },
      return: { text: '{"secret":"RAW_TOOL_RETURN"}' },
    } });
    const eventsBefore = loadEvents(dir, "cv_01");
    const view = sessionView(dir, "cv_01");
    expect(view.messages).toEqual([
      { turnId: "tn_01", role: "user", text: "查看当前页面" },
      { turnId: "tn_01", role: "tool", text: "INTERNAL_REASON" },
      { turnId: "tn_01", role: "tool", name: "page.get_summary", text: "读取页面摘要" },
      { turnId: "tn_01", role: "assistant", text: expected },
    ]);
    expect(JSON.stringify(view)).not.toContain("INTERNAL_PAGE_DATA");
    expect(JSON.stringify(view)).not.toContain("INTERMEDIATE_ACTION");
    expect(JSON.stringify(view)).not.toContain("RAW_TOOL_RETURN");
    expect(loadEvents(dir, "cv_01")).toEqual(eventsBefore);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("running legacy toolIO and live queue retain reasons without raw returns", () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-session-progress-"));
  try {
    const ledger = emptyLedger("cv_01");
    ledger.turnIds = ["tn_01"];
    ledger.status = "running";
    ledger.active = { turnId: "tn_01" };
    ledger.toolIO = [{ turnId: "tn_01", callId: "old", name: "page.get_summary", arguments: {},
      return: { stage: "complete", totalChars: 18, text: '{"data":"PRIVATE"}' } }];
    ledger.liveTool = { callId: "live", name: "page.click" };
    ledger.toolQueue = [{ callId: "queued", name: "page.type", arguments: { reason: "很长的进度说明".repeat(30) } }];
    saveLedger(dir, ledger);
    saveTurn(dir, makeTurn(null));
    appendEvent(dir, "cv_01", { kind: "provider-response", turnId: "tn_01", data: { content: "seen\nPRIVATE" } });
    const view = sessionView(dir, "cv_01");
    expect(view.messages.map((row) => row.role)).toEqual(["user", "tool", "tool", "tool"]);
    expect(view.messages[1]?.text).toBe("工具调用已结束");
    expect(view.messages[2]).toMatchObject({ name: "page.click", text: "正在执行工具", live: true });
    expect(view.messages[3]?.text).toBe("很长的进度说明".repeat(30));
    expect(JSON.stringify(view)).not.toContain("PRIVATE");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
