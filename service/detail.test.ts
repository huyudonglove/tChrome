import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTurn } from "./runtime/loop.ts";
import { ensureSession, loadLedger, saveLedger, stopTurn, sessionView, loadFullReturn } from "./runtime/store.ts";
import { allocateRecordId } from "./runtime/ids.ts";
import { commitArchive, loadIndex } from "./context-archive/store.ts";
import type { CompletionResult, Provider, LoopRecord, LoopToolResult } from "./types.ts";
const repoRoot = join(import.meta.dir, "..");
const reply = (toolCalls: CompletionResult["toolCalls"]): CompletionResult => ({ content: "", finish: "tool_calls", toolCalls, attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [] });
const finish = () => reply([{ id: "finish", name: "finishTurn", arguments: { reason: "已核对", text: "完成" } }]);
const queryCall = (sumId: string) => reply([{ id: "query", name: "context_query", arguments: { keepInCalls: true, reason: "查原文", sumId, module: "runtime", intent: "读取详细证据" } }]);
const queryResults = (dataDir: string, cv: string) => loadLedger(dataDir, cv).loops.flatMap(loop => loop.runtime)
  .filter(row => row.type === "callsResult").flatMap(row => row.content as LoopToolResult[]).filter(row => row.name === "context_query");
function fixture(dataDir: string, text: string, largeHistory = false) {
  const { conversationId: cv } = ensureSession(dataDir), ledger = loadLedger(dataDir, cv);
  const makeLoop = (content: unknown, type: "userInput" | "callsResult"): LoopRecord => ({
    id: allocateRecordId(dataDir, cv, "loop"), conversationId: cv, turnId: "tn_history", createdAt: "2026-09-12",
    sentAt: "2026-09-12", completedAt: "2026-09-12",
    runtime: [{ id: allocateRecordId(dataDir, cv, "runtime"), type, content }],
    helm: { id: allocateRecordId(dataDir, cv, "helm"), content: "已处理", calls: [], finish: "stop" },
  });
  const tool = { callId: allocateRecordId(dataDir, cv, "call"), name: "page_get_summary", result: { ok: true, text }, keepInCalls: true };
  const archived = makeLoop([tool], "callsResult");
  ledger.loops.push(archived);
  if (largeHistory) for (let i = 0; i < 5; i++) ledger.loops.push(makeLoop(`要求${i}:` + "历史内容".repeat(12000), "userInput"));
  const sumId = allocateRecordId(dataDir, cv, "sum");
  const summary = { id: sumId, module: "conversationHistory" as const, level: 1, loopIds: [archived.id], summary: "详情读取完成。", userRequest: "读取详情", actions: "读取页面", result: "已取得证据", sourceIds: [archived.id], createdAt: "2026-09-12" };
  commitArchive(dataDir, cv, { version: 1, module: "conversationHistory", entries: [summary], activeIds: [sumId], coveredSourceIds: [archived.id] }, [{ id: archived.id, content: archived }], [summary]);
  saveLedger(dataDir, ledger);
  return { cv, sumId, tool, archived };
}

test("loop compression preserves retrievable sources and query results persist directly in runtime", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "query-loop-"));
  try {
    const f = fixture(dataDir, "精确证据".repeat(100), true);
    let main = 0, compressed = 0;
    const provider: Provider = { complete: async input => {
      if (input.tools[0]?.function.name === "submitMatches") return reply([{ id: "matches", name: "submitMatches", arguments: { loopIds: [f.archived.id] } }]);
      if (input.tools[0]?.function.name === "submitLoopSummaries") {
        compressed++;
        expect(input.messages[1]!.content).not.toContain(f.tool.result.text);
        expect(sessionView(dataDir, f.cv).activity?.kind).toBe("compressing");
        return reply([{ id: "summaries", name: "submitLoopSummaries", arguments: { summary: "早期要求已处理完成。", actions: "已处理", result: "已完成" } }]);
      }
      main++;
      if (main === 1) { expect(compressed).toBeGreaterThan(0); return queryCall(f.sumId); }
      const user = input.messages[1]!.content;
      expect(user).toContain('type="callsResult"');
      expect(user).toContain(f.tool.result.text);
      expect(user).not.toContain("<query ");
      expect(user).not.toContain("<notes>");
      expect(user).not.toContain("<workspaces>");
      expect(sessionView(dataDir, f.cv).activity).toBeNull();
      return finish();
    } };
    expect((await handleTurn({ repoRoot, dataDir, provider }, { userInput: "读取详情", submittedAt: "2026-09-12" })).stopReason).toEqual({ kind: "reply", text: "完成" });
    const results = queryResults(dataDir, f.cv);
    expect(results).toHaveLength(1);
    expect(results[0]!.result).toMatchObject({ status: "complete", sumId: f.sumId, records: [{ id: f.archived.runtime[0]!.id, content: [f.tool] }] });
    expect(loadIndex(dataDir, f.cv, "conversationHistory").coveredSourceIds.length).toBeGreaterThan(1);
    await handleTurn({ repoRoot, dataDir, provider }, { userInput: "继续", submittedAt: "2026-09-12" });
    expect(queryResults(dataDir, f.cv)).toEqual(results);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("large query uses the unified result gate and cancelling the next query preserves previous runtime evidence", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "query-pages-"));
  try {
    const f = fixture(dataDir, "原始证据".repeat(1800)); let main = 0, aux = 0;
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const provider: Provider = { complete: async input => {
      if (input.tools[0]?.function.name === "submitMatches") {
        aux++;
        if (aux === 2) { started(); await blocked; }
        return reply([{ id: "matches", name: "submitMatches", arguments: { loopIds: [f.archived.id] } }]);
      }
      main++;
      if (main === 1) return queryCall(f.sumId);
      const results = queryResults(dataDir, f.cv);
      expect(results).toHaveLength(1);
      expect(results[0]!.result).toMatchObject({ ok: true, status: "complete", externalized: true, search: "evidence_search" });
      expect(input.messages[1]!.content).not.toContain(f.tool.result.text);
      expect(loadFullReturn(dataDir, f.cv, results[0]!.callId)).toContain(f.tool.result.text);
      return queryCall(f.sumId);
    } };
    const running = handleTurn({ repoRoot, dataDir, provider }, { userInput: "读取详情", submittedAt: "2026-09-12" });
    await entered;
    const before = queryResults(dataDir, f.cv);
    stopTurn(dataDir); release();
    expect((await running).stopReason).toEqual({ kind: "interrupted", initiatedBy: "user" });
    expect(queryResults(dataDir, f.cv)).toEqual(before);
    expect(before).toHaveLength(1);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
