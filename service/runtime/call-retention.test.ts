import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTurn } from "./loop.ts";
import { ensureSession, loadLedger, loadTurn, saveLedger } from "./store.ts";
import { assembleTurnHistory } from "./turn-history.ts";
import type { CompletionResult, Provider } from "../types.ts";

const repoRoot = join(import.meta.dir, "../..");
const response = (toolCalls: CompletionResult["toolCalls"]): CompletionResult => ({
  finish: "tool_calls", content: "", toolCalls, attempts: 1,
  parseOk: true, schemaOk: true, faultCode: null, missing: [],
});
const finish = () => response([{ id: "finish", name: "finishTurn", arguments: { reason: "完成", text: "完成" } }]);
const callIds = (text: string) => [...text.matchAll(/<call\s+callId="([^"]+)"/g)].map(match => match[1]!);
const setup = () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-call-retention-"));
  const { conversationId } = ensureSession(dataDir);
  const ledger = loadLedger(dataDir, conversationId);
  ledger.loadedToolIds = ["page_get_summary"];
  saveLedger(dataDir, ledger);
  return { dataDir, conversationId };
};

test("latest batch is visible once, explicit keeps survive turns, storage and archive retain all calls", async () => {
  const { dataDir, conversationId } = setup();
  try {
    const sentToHost: Record<string, unknown>[] = [];
    const host = { execute: async (_name: string, args: Record<string, unknown>) => {
      sentToHost.push(args);
      return { ok: true, title: `tab-${args.tabId}`, url: "https://example.com" };
    } };
    let step = 0;
    let firstCallIds: string[] = [];
    const provider: Provider = { complete: async input => {
      step++;
      const window = input.messages[1]!.content;
      if (step === 1) return response([
        { id: "keep", name: "page_get_summary", arguments: { reason: "保留", tabId: 1, keepInCalls: true } },
        { id: "once", name: "page_get_summary", arguments: { reason: "单次", tabId: 2, keepInCalls: false } },
        { id: "unset", name: "page_get_summary", arguments: { reason: "未指定", tabId: 3 } },
      ]);
      if (step === 2) {
        firstCallIds = loadLedger(dataDir, conversationId).toolIO.map(row => row.callId);
        expect(firstCallIds).toHaveLength(3);
        expect(callIds(window)).toEqual(firstCallIds);
        return response([{ id: "record", name: "workspace_write", arguments: { reason: "记录", op: "查看三个页面", value: "页面正常" } }]);
      }
      expect(callIds(window)).toEqual([firstCallIds[0]!, loadLedger(dataDir, conversationId).toolIO.at(-1)!.callId]);
      return finish();
    } };
    const first = await handleTurn({ dataDir, repoRoot, provider, host }, { userInput: "检查", submittedAt: "now" });
    expect(first.stopReason).toEqual({ kind: "reply", text: "完成" });
    expect(step).toBe(3);
    expect(sentToHost.filter(args => "tabId" in args).map(args => args.tabId)).toEqual([1, 2, 3]);
    expect(sentToHost.every(args => !("keepInCalls" in args))).toBe(true);
    const reloaded = loadLedger(dataDir, conversationId);
    expect(reloaded.toolIO.slice(0, 3).map(row => row.arguments.keepInCalls)).toEqual([true, false, undefined]);
    expect(reloaded.toolIO).toHaveLength(5);
    const archive = assembleTurnHistory(reloaded, loadTurn(dataDir, conversationId, first.turnId));
    expect(archive.toolIO).toEqual(reloaded.toolIO);
    const secondProvider: Provider = { complete: async input => {
      const window = input.messages[1]!.content;
      expect(callIds(window)).toEqual([firstCallIds[0]!]);
      const historical = [...window.matchAll(/<turn\s+turnId="([^"]+)"[^>]*>([\s\S]*?)<\/turn>/g)].find(match => match[1] === first.turnId);
      expect(historical).toBeDefined();
      expect(callIds(historical![2]!)).toEqual([firstCallIds[0]!]);
      return finish();
    } };
    const second = await handleTurn({ dataDir, repoRoot, provider: secondProvider, host }, { userInput: "继续", submittedAt: "now" });
    expect(second.stopReason).toEqual({ kind: "reply", text: "完成" });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("invalid keepInCalls replaces previous transient results with a visible schema failure and can be corrected", async () => {
  const { dataDir, conversationId } = setup();
  try {
    let step = 0;
    let oldCallId = "";
    let failedCallId = "";
    let executed = 0;
    const provider: Provider = { complete: async input => {
      step++;
      const window = input.messages[1]!.content;
      if (step === 1) return response([{ id: "old", name: "page_get_summary", arguments: { reason: "读取", tabId: 1, keepInCalls: false } }]);
      if (step === 2) {
        oldCallId = loadLedger(dataDir, conversationId).toolIO.at(-1)!.callId;
        expect(callIds(window)).toEqual([oldCallId]);
        return response([{ id: "invalid", name: "page_get_summary", arguments: { reason: "读取", tabId: 2, keepInCalls: "true" as unknown as boolean } }]);
      }
      if (step === 3) {
        const failed = loadLedger(dataDir, conversationId).toolIO.at(-1)!;
        failedCallId = failed.callId;
        expect(failedCallId).not.toBe(oldCallId);
        expect(callIds(window)).toEqual([failedCallId]);
        expect(window).toContain("keepInCalls");
        expect(window).toContain('ok="false"');
        return response([{ id: "corrected", name: "page_get_summary", arguments: { reason: "修正类型", tabId: 2, keepInCalls: true } }]);
      }
      const corrected = loadLedger(dataDir, conversationId).toolIO.at(-1)!;
      expect(callIds(window)).toEqual([corrected.callId]);
      expect(callIds(window)).not.toContain(failedCallId);
      return finish();
    } };
    const result = await handleTurn({ dataDir, repoRoot, provider, host: { execute: async name => {
      if (name === "page_get_summary") executed++;
      return { ok: true, title: "page", url: "https://example.com" };
    } } }, { userInput: "检查并修正", submittedAt: "now" });
    expect(result.stopReason).toEqual({ kind: "reply", text: "完成" });
    expect(step).toBe(4);
    const ledger = loadLedger(dataDir, conversationId);
    const business = ledger.toolIO.filter(row => row.name === "page_get_summary");
    expect(business).toHaveLength(3);
    expect(business[1]!.return.text).toContain("keepInCalls");
    expect(executed).toBe(2);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
