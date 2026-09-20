import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTurn } from "./runtime/loop.ts";
import { ensureSession, loadLedger, saveLedger, saveTurn, stopTurn, sessionView } from "./runtime/store.ts";
import { allocateRecordId, inputRecord, pacificDate } from "./runtime/ids.ts";
import { archiveDir, commitArchive, loadIndex } from "./context-archive/store.ts";
import { loadContextModules } from "./context/modules.ts";
import { validateUserData } from "./context/data-schema.ts";
import { systemText, userText } from "./context/window.ts";
import { loadToolRegistry, coreToolIds, toolGuideFor } from "./tools/registry.ts";
import { loadSkills } from "./skills/loader.ts";
import { contextState } from "./runtime/context-state.ts";
import { compressionTurnsFromUserMessage } from "./agents/compression/protocol.ts";
import type { CompletionResult, Provider, Turn } from "./types.ts";
const repoRoot = join(import.meta.dir, "..");
const reply = (toolCalls: CompletionResult["toolCalls"]): CompletionResult => ({ content: "", finish: "tool_calls", toolCalls, attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [] });
const finish = () => reply([{ id: "finish", name: "finishTurn", arguments: { reason: "已核对", affectsPage: false, text: "完成"} }]);
const section = (user: string, tag: string) => {
  const m = user.match(new RegExp(`<${tag}>\\n[\\s\\S]*?\\n\\n内容：\\n([\\s\\S]*?)\\n</${tag}>`));
  return JSON.parse(m![1]!);
};
function fixture(dataDir: string, text = "精确证据".repeat(250)) {
  const { conversationId: cv } = ensureSession(dataDir), ledger = loadLedger(dataDir, cv);
  const turns = Array.from({ length: 6 }, (_, i): Turn => ({ goalChanges: [], conversationId: cv, turnId: allocateRecordId(dataDir, cv, "turn"), status: "completed", createdAt: "2026-09-12", completedAt: "2026-09-12", input: { id: allocateRecordId(dataDir, cv, "input"), text: `要求${i}`, submittedAt: "2026-09-12" }, assembled: { baseToolsIds: [], toolIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], openTabs: { ok: true, windows: [] }, currentPage: null, pageObservedHistory: [] }, output: { kind: "reply", text: "完成" } }));
  ledger.turnIds = turns.map(row => row.turnId); ledger.userInputHistory = turns.slice(0, -1).map(inputRecord);
  turns.forEach(turn => saveTurn(dataDir, turn));
  const tool = { callId: allocateRecordId(dataDir, cv, "call"), turnId: "tn_01", batchId: allocateRecordId(dataDir, cv, "batch"), name: "page.get_summary", arguments: {}, return: { stage: "complete", totalChars: text.length, text } };
  const sumId = allocateRecordId(dataDir, cv, "sum");
  const sourceId = allocateRecordId(dataDir, cv, "source");
  const summary = { id: sumId, module: "conversationHistory" as const, level: 1, turnId: "tn_01", tag: "详情", userRequest: "读取详情", actions: "读取页面", result: "已取得证据", sourceIds: [sourceId], createdAt: "2026-09-12" };
  commitArchive(dataDir, cv, { version: 1, module: "conversationHistory", entries: [summary], activeIds: [sumId], coveredSourceIds: [sourceId] }, [{ id: sourceId, content: { turnId: "tn_01", userInput: inputRecord(turns[0]!), toolIO: [tool] } }], [summary]);
  writeFileSync(join(archiveDir(dataDir, cv, "conversationHistory"), "source-ids.json"), JSON.stringify({ [JSON.stringify(["turn", "tn_01"])]: sourceId }));
  saveLedger(dataDir, ledger);
  return { cv, ledger, turns, sumId, tool };
}
const queryCall = (sumId: string, module = "toolIO") => reply([{ id: "query", name: "context.query", arguments: { reason: "查原文", affectsPage: false, sumId, module, intent: "读取详细证据" } }]);

test("query insertion triggers the 200K gate, protects current evidence, rotates and persists history", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "query-loop-"));
  try {
    const f = fixture(dataDir), registry = loadToolRegistry(repoRoot), modules = loadContextModules(repoRoot);
    const next: Turn = { ...f.turns[5]!, turnId: "tn_07", input: { id: "input_07", text: "读取详情", submittedAt: "2026-09-12" }, assembled: { ...f.turns[5]!.assembled, baseToolsIds: registry.toolGroups.baseToolsIds, toolIds: coreToolIds(registry) } };
    const previewLedger = { ...f.ledger, userInputHistory: f.turns.map(inputRecord) };
    const view = contextState(dataDir, previewLedger, next, { project: [], conversation: [] });
    const overhead = systemText(modules, pacificDate(), toolGuideFor(registry, next.assembled.baseToolsIds)).length + userText({ contextModules: modules, ledger: view.ledger, turn: next, conversationSummaries: view.summaries, memories: { project: "[]", conversation: "[]" }, skillText: loadSkills(repoRoot), toolGuide: toolGuideFor(registry, next.assembled.toolIds) }).length;
    f.turns[1]!.input.text += "x".repeat(200000 - overhead - 500);
    saveTurn(dataDir, f.turns[1]!); f.ledger.userInputHistory = f.turns.slice(0, -1).map(inputRecord); saveLedger(dataDir, f.ledger);
    let main = 0, compressed = 0;
    const provider: Provider = { complete: async input => {
      if (input.tools[0]?.function.name === "submitMatches") return reply([{ id: "matches", name: "submitMatches", arguments: { turnIds: ["tn_01"] } }]);
      if (input.tools[0]?.function.name === "submitTurnSummaries") {
        compressed++; expect(input.messages[1]!.content).not.toContain(f.tool.return.text);
        expect(main).toBe(1);
        expect(sessionView(dataDir, f.cv).activity).toMatchObject({ kind: "compressing", phase: "history" });
        expect(sessionView(dataDir, f.cv).activity?.total).toBeGreaterThan(0);
        return reply([{ id: "summaries", name: "submitTurnSummaries", arguments: { tag: "早期要求", actions: "已处理", result: "已完成" } }]);
      }
      main++;
      if (main === 1) { expect(compressed).toBe(0); return queryCall(f.sumId); }
      if (main === 2) {
        expect(compressed).toBeGreaterThan(0);
        expect(sessionView(dataDir, f.cv).activity).toBeNull();
        const values = Object.fromEntries(modules.userOrder.map(tag => {
          const id = tag.slice(1);
          const m = input.messages[1]!.content.match(new RegExp(`<${id}>\\n[\\s\\S]*?\\n\\n内容：\\n([\\s\\S]*?)\\n</${id}>`));
          const body = m![1]!;
          return [id, id === "skill" || id === "tools" ? body : JSON.parse(body)];
        }));
        expect(validateUserData(values), JSON.stringify(validateUserData.errors)).toBe(true);
        const current = section(input.messages[1]!.content, "currentQuery");
        const toolIO = section(input.messages[1]!.content, "toolIO");
        const queryRow = toolIO.find((row: any) => row.name === "context.query");
        expect(queryRow?.return?.result).toMatchObject({ currentQuery: true });
        expect(JSON.stringify(queryRow)).not.toContain(f.tool.return.text);
        if (current.externalized) {
          expect(current.search).toBe("evidence.search");
          expect(String(current.preview).length).toBeGreaterThan(0);
        } else {
          expect(current.records).toEqual([f.tool]);
        }
        expect(JSON.stringify(toolIO)).not.toContain(f.tool.return.text);
        return queryCall(f.sumId, "userInput");
      }
      if (main === 3) {
        expect(section(input.messages[1]!.content, "queryHistory")).toHaveLength(1);
        expect(section(input.messages[1]!.content, "currentQuery").queryId).toBe("query_02");
      } else {
        expect(section(input.messages[1]!.content, "currentQuery")).toBeNull();
        expect(section(input.messages[1]!.content, "queryHistory").map((q: {turnId:string}) => q.turnId)).toEqual(["tn_07", "tn_07"]);
      }
      return finish();
    } };
    expect((await handleTurn({ repoRoot, dataDir, provider }, { userInput: "读取详情", submittedAt: "2026-09-12" })).output).toEqual({ kind: "reply", text: "完成" });
    expect(loadLedger(dataDir, f.cv).currentQuery?.queryId).toBe("query_02");
    expect(loadIndex(dataDir, f.cv, "conversationHistory").coveredSourceIds).toContain("src_02");
    await handleTurn({ repoRoot, dataDir, provider }, { userInput: "继续", submittedAt: "2026-09-12" });
    expect(loadLedger(dataDir, f.cv).currentQuery).toBeNull();
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("unified gate externalizes large currentQuery and cancellation preserves the previous query", async () => {
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
        return reply([{ id: "matches", name: "submitMatches", arguments: { turnIds: ["tn_01"] } }]);
      }
      main++;
      if (main === 1) return queryCall(f.sumId);
      const current = section(input.messages[1]!.content, "currentQuery");
      expect(current.externalized).toBe(true);
      expect(current.search).toBe("evidence.search");
      expect(current.preview).toBeDefined();
      expect(current.records).toEqual([]);
      return queryCall(f.sumId, "userInput");
    } };
    const running = handleTurn({ repoRoot, dataDir, provider }, { userInput: "读取详情", submittedAt: "2026-09-12" });
    await entered;
    const before = loadLedger(dataDir, f.cv).currentQuery;
    stopTurn(dataDir); release();
    expect((await running).output).toEqual({ kind: "error", faultCode: "stopped" });
    const after = loadLedger(dataDir, f.cv);
    expect(after.currentQuery).toEqual(before);
    // Second query was cancelled mid-flight; first query remains current (not yet rotated to history).
    expect(after.queryHistory).toEqual([]);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
