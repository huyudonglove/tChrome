import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendRuntime, inputLoop, recordHelm, recordToolResult, setLoopNotice } from "./loop-records.ts";
import { emptyLedger, loadLedger, paths, saveLedger } from "./store.ts";
import { handleTurn } from "./loop.ts";
import type { CompletionResult, LoopToolResult } from "../types.ts";

const response = (content: string): CompletionResult => ({ finish: "stop", content, toolCalls: [], attempts: 1, parseOk: true, schemaOk: true, missing: [], faultCode: null });

test("published loops are immutable; results, notices and new input assemble in the next request", () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-records-"));
  try {
    const ledger = emptyLedger("cv_01");
    appendRuntime(dir, ledger, "tn_01", "userInput", "检查页面");
    setLoopNotice(dir, ledger, "tn_01", "tools", "工具已加载");
    const first = inputLoop(dir, ledger, "tn_01");
    const noticeId = first.runtime[1]!.id;
    setLoopNotice(dir, ledger, "tn_01", "tools", "工具已加载");
    expect(first.runtime[1]!.id).toBe(noticeId);
    first.sentAt = "sent";
    recordHelm(dir, ledger, first, response("开始读取"));
    const frozen = JSON.stringify(first);
    recordToolResult(dir, ledger, { turnId: "tn_01", callId: "call_01", name: "local_fs_read", arguments: {}, return: { stage: "complete", totalChars: 12, text: '{"ok":true}' } });
    setLoopNotice(dir, ledger, "tn_01", "tools", null);
    appendRuntime(dir, ledger, "tn_02", "interrupt", "先不要修改");
    expect(ledger.loops).toHaveLength(2);
    expect(JSON.stringify(first)).toBe(frozen);
    expect(ledger.loops[1]!.runtime.map(row => row.type)).toEqual(["callsResult", "interrupt"]);
    expect((ledger.loops[1]!.runtime[0]!.content as LoopToolResult[])[0]!.keepInCalls).toBe(true);
    saveLedger(dir, ledger);
    expect(loadLedger(dir, "cv_01").loops).toEqual(ledger.loops);
    const ids = ledger.loops.flatMap(loop => [loop.id, ...loop.runtime.map(row => row.id), ...(loop.helm ? [loop.helm.id] : [])]);
    expect(new Set(ids).size).toBe(ids.length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("main requests persist separate Helm responses and next-loop tool results without duplicate evidence modules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-flow-"));
  try {
    let step = 0;
    const reply = await handleTurn({ dataDir: dir, repoRoot: join(import.meta.dir, "../.."), provider: { complete: async input => {
      step++;
      if (step === 1) return { ...response("记录判断"), finish: "tool_calls" as const,
        toolCalls: [{ id: "external-id", name: "reflect_write", arguments: { text: "缺少的是测试返回，下一步取得返回", reason: "确定下一步" } }] };
      const user = input.messages[1]!.content;
      expect(user).toContain('type="callsResult"');
      expect(user).toContain('"content":"记录判断"');
      expect(user).toContain('"id":"call_01"');
      for (const tag of ["turn", "notes", "workspaces", "observations", "reflections", "queries", "runtimeNotices"]) expect(user).not.toMatch(new RegExp(`<${tag}[ >]`));
      expect(user.lastIndexOf("<contextUsage")).toBeGreaterThan(user.lastIndexOf("</conversation>"));
      return response("已确认下一步");
    } } }, { userInput: "检查", submittedAt: "now" });
    expect(reply.stopReason).toEqual({ kind: "reply", text: "已确认下一步" });
    const ledger = loadLedger(dir, reply.conversationId);
    expect(ledger.loops.filter(loop => loop.helm)).toHaveLength(2);
    expect(ledger.loops[0]!.helm!.calls[0]!.id).toBe("call_01");
    expect(ledger.loops[1]!.runtime.some(row => row.type === "callsResult")).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("old conversation schema is rejected rather than normalized or migrated", () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-schema-"));
  try {
    saveLedger(dir, emptyLedger("cv_01"));
    writeFileSync(paths(dir, "cv_01").ledger, JSON.stringify({ schemaVersion: 2, conversationId: "cv_01" }));
    expect(() => loadLedger(dir, "cv_01")).toThrow("unsupported_conversation_schema");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("closing reply and provider failure remain visible across later user inputs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-outcomes-"));
  const repoRoot = join(import.meta.dir, "../..");
  try {
    const first = await handleTurn({ dataDir: dir, repoRoot, provider: { complete: async () => ({
      ...response(""), finish: "tool_calls", toolCalls: [{ id: "finish", name: "finishTurn", arguments: { text: "修复已完成，未重启" } }],
    }) } }, { userInput: "修复", submittedAt: "now" });
    await handleTurn({ dataDir: dir, repoRoot, provider: { complete: async input => {
      expect(input.messages[1]!.content).toContain("修复已完成，未重启");
      return { ...response(""), finish: "error", faultCode: "provider_error", detail: "upstream HTTP 503" };
    } } }, { userInput: "继续检查", submittedAt: "now", conversationId: first.conversationId });
    const reply = await handleTurn({ dataDir: dir, repoRoot, provider: { complete: async input => {
      expect(input.messages[1]!.content).toContain("修复已完成，未重启");
      expect(input.messages[1]!.content).toContain("upstream HTTP 503");
      return response("已恢复");
    } } }, { userInput: "重试", submittedAt: "now", conversationId: first.conversationId });
    expect(reply.stopReason).toEqual({ kind: "reply", text: "已恢复" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
