import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyLedger, saveTurn, ensureSession, saveLedger, loadLedger, stopTurn } from "./store.ts";
import { allocateRecordId, inputRecord } from "./ids.ts";
import { contextState, compressContext } from "./context-state.ts";
import { compressionTurnsFromUserMessage } from "../agents/compression/protocol.ts";
import { loadIndex, resolveSources, commitArchive } from "../context-archive/store.ts";
import { SUMMARY_RECOMPRESS_MIN_ACTIVE } from "../agents/compression/index.ts";
import type { Ledger, Turn, Provider, CompletionResult } from "../types.ts";
import type { Memories } from "../memory/types.ts";
import { handleTurn } from "./loop.ts";
const repoRoot = join(import.meta.dir, "../..");
const makeTurn = (cv: string, id: string, text = id): Turn => ({ goalChanges: [], conversationId: cv, turnId: id, status: "completed", createdAt: "2026-09-11", completedAt: "2026-09-11", input: { id: `input_${id}`, text, submittedAt: "2026-09-11" }, assembled: { baseToolsIds: [], toolIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], openTabs: { ok: true, windows: [] }, currentPage: null, pageObservedHistory: [] }, output: { kind: "reply", text: `完成${id}` } });
const result = (partial: Partial<CompletionResult>): CompletionResult => ({ finish: "tool_calls", content: "", toolCalls: [], attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [], ...partial });
const summaryResponse = (_messages: Parameters<Provider["complete"]>[0]["messages"]) => result({ toolCalls: [{ id: "submit", name: "submitTurnSummaries", arguments: { tag: "历史事项", actions: "已检查", result: "该轮已完成" } }] });
const oneTurnOf = (messages: Parameters<Provider["complete"]>[0]["messages"]) => {
  const turns = compressionTurnsFromUserMessage(messages[1]!.content);
  expect(turns).toHaveLength(1);
  return turns[0]!;
};
function seed(dataDir: string, ledger: Ledger, count = 5, big = false) {
  const turns = Array.from({ length: count }, (_, i) => makeTurn(ledger.conversationId, allocateRecordId(dataDir, ledger.conversationId, "turn"), big ? "原始要求".repeat(12000) : `要求${i}`));
  ledger.turnIds = turns.map(turn => turn.turnId);
  ledger.userInputHistory = turns.slice(0, -1).map(inputRecord);
  turns.forEach(turn => saveTurn(dataDir, turn));
  return turns;
}

test("whole-turn grouping removes covered module increments, retaining current state without protecting recent settled turns", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "context-turns-"));
  try {
    const ledger = emptyLedger("cv_test"), turns = seed(dataDir, ledger);
    ledger.userInputHistory = turns.map(inputRecord);
    ledger.toolIO = turns.map(turn => ({ callId: `call_${turn.turnId}`, turnId: turn.turnId, batchId: `batch_${turn.turnId}`, name: "memory.write", arguments: {}, return: { stage: "complete", text: "成功", totalChars: 2 } }));
    ledger.goals = turns.map(turn => ({ parentId: null, status: "completed", updatedAt: "2026-09-11", id: `goal_${turn.turnId}`, turnId: turn.turnId, goal: `目标${turn.turnId}`, sourceCallId: `call_${turn.turnId}`, createdAt: "2026-09-11" }));
    ledger.goals[0]!.status = "active";
    ledger.currentGoalId = ledger.goals[0]!.id;
    turns.forEach((turn, i) => { turn.goalChanges = [structuredClone(ledger.goals[i]!)]; saveTurn(dataDir, turn); });
    ledger.notes = { draft: "当前草稿" };
    const memories: Memories = { project: [], conversation: turns.map(turn => ({ memoryId: `mm_${turn.turnId}`, turnId: turn.turnId, layer: "conversation", text: `记忆${turn.turnId}`, createdAt: "2026-09-11", sourceCallId: `call_${turn.turnId}` })) };
    const current = makeTurn(ledger.conversationId, "tn_06"); current.status = "inferring"; current.output = null; current.completedAt = null;
    ledger.turnIds.push(current.turnId); ledger.active = { turnId: current.turnId };
    let calls = 0;
    const provider: Provider = { complete: async input => {
      calls++; expect(input.tools.map(tool => tool.function.name)).toEqual(["submitTurnSummaries"]);
      const source = oneTurnOf(input.messages);
      expect(source.turnId).toBe(`tn_0${calls}`);
      expect(source.memoryWrites[0].turnId).toBe(source.turnId);
      expect((source.output as { text?: string }).text).toBe(`完成${source.turnId}`);
      return summaryResponse(input.messages);
    } };
    const before = JSON.stringify({ ledger, current, memories });
    await compressContext({ dataDir, repoRoot, provider, ledger, turn: current, memories, isCancelled: () => false });
    const view = contextState(dataDir, ledger, current, memories);
    expect(view.ledger.userInputHistory.map(row => row.turnId)).toEqual([]);
    expect(view.ledger.goals.filter(row => row.status !== "active").map(row => row.turnId)).toEqual([]);
    expect(view.ledger.toolIO).toHaveLength(0); expect(view.memories.conversation).toHaveLength(0);
    expect(view.ledger.goals.filter(row => row.status === "active")).toEqual(ledger.goals.filter(row => row.status === "active")); expect(view.ledger.notes).toEqual(ledger.notes);
    expect(view.summaries.map(row => row.turnId)).toEqual(["tn_01", "tn_02", "tn_03", "tn_04", "tn_05"]);
    expect(JSON.stringify({ ledger, current, memories })).toBe(before);
    await compressContext({ dataDir, repoRoot, provider, ledger, turn: current, memories, isCancelled: () => false });
    expect(calls).toBe(5);
    expect(loadIndex(dataDir, ledger.conversationId, "conversationHistory").coveredSourceIds).toEqual(["src_01", "src_02", "src_03", "src_04", "src_05"]);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

for (const fail of [false, true]) test(`sequential 200K walk archives prefix; failure=${fail} keeps later originals and continues main`, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "context-boundary-"));
  try {
    const session = ensureSession(dataDir), ledger = loadLedger(dataDir, session.conversationId); seed(dataDir, ledger, 5, true); saveLedger(dataDir, ledger);
    let main = 0, aux = 0;
    const provider: Provider = { complete: async input => {
      if (input.tools[0]?.function.name === "submitTurnSummaries") {
        aux++;
        const source = oneTurnOf(input.messages);
        if (fail && source.turnId === "tn_03") return result({ finish: "error", faultCode: "test_error" });
        return summaryResponse(input.messages);
      }
      main++;
      if (!fail) expect(input.messages[1]!.content).toContain("该轮已完成");
      expect(input.messages[1]!.content).not.toContain("#toolIOSummary");
      return result({ toolCalls: [{ id: "finish", name: "finishTurn", arguments: { reason: "完成", affectsPage: false, text: "完成"} }] });
    } };
    const reply = await handleTurn({ dataDir, repoRoot, provider }, { userInput: "继续", submittedAt: "2026-09-11" });
    expect(reply.output).toEqual({ kind: "reply", text: "完成" });
    expect(main).toBe(1);
    expect(aux).toBe(fail ? 3 : 5);
    expect(loadLedger(dataDir, session.conversationId).userInputHistory).toHaveLength(5);
    expect(loadIndex(dataDir, session.conversationId, "conversationHistory").coveredSourceIds).toEqual(fail ? ["src_01", "src_02"] : ["src_01", "src_02", "src_03", "src_04", "src_05"]);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("below 200K no compression request occurs at turn boundary", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "context-below-"));
  try {
    const session = ensureSession(dataDir), ledger = loadLedger(dataDir, session.conversationId); seed(dataDir, ledger); saveLedger(dataDir, ledger);
    const provider: Provider = { complete: async input => { expect(input.tools[0]!.function.name).not.toBe("submitTurnSummaries"); return result({ toolCalls: [{ id: "finish", name: "finishTurn", arguments: { reason: "完成", affectsPage: false, text: "完成"} }] }); } };
    await handleTurn({ dataDir, repoRoot, provider }, { userInput: "继续", submittedAt: "2026-09-11" });
    expect(loadIndex(dataDir, session.conversationId, "conversationHistory").activeIds).toEqual([]);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("stop during batched compression cannot commit coverage or overwrite paused session", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "context-stop-"));
  try {
    const session = ensureSession(dataDir), ledger = loadLedger(dataDir, session.conversationId); seed(dataDir, ledger, 5, true); saveLedger(dataDir, ledger);
    let release!: () => void, started!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
    const provider: Provider = { complete: async input => { started(); await pending; return summaryResponse(input.messages); } };
    const running = handleTurn({ dataDir, repoRoot, provider }, { userInput: "继续", submittedAt: "2026-09-11" });
    await entered; stopTurn(dataDir); release();
    expect((await running).output).toEqual({ kind: "error", faultCode: "stopped" });
    expect(loadLedger(dataDir, session.conversationId).status).toBe("paused");
    expect(loadIndex(dataDir, session.conversationId, "conversationHistory").coveredSourceIds).toEqual([]);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("long current turn archives older complete batches and keeps input, current goal/page and last two batches", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "context-segment-"));
  try {
    const ledger = emptyLedger("cv_test"), current = makeTurn(ledger.conversationId, "tn_01");
    current.status = "inferring"; current.output = null; current.completedAt = null; ledger.turnIds = [current.turnId]; ledger.active = { turnId: current.turnId };
    ledger.toolIO = Array.from({ length: 6 }, (_, i) => ({ callId: `call_${i}`, turnId: current.turnId, batchId: `b_${Math.floor(i / 2)}`, name: "page.get_summary", arguments: {}, return: { stage: "complete" as const, text: "结果", totalChars: 2 } }));
    current.assembled.pageObservedHistory = ledger.toolIO.map((row, i) => ({ id: `p_${i}`, turnId: current.turnId, callId: row.callId, toolName: row.name, tabId: 1, url: "https://example.com", title: "页面", description: `状态${i}`, observedAt: "2026-09-11" }));
    current.assembled.currentPage = current.assembled.pageObservedHistory[5]!;
    ledger.goals = [{ parentId: null, status: "active", updatedAt: "2026-09-11", ...{ id: "goal_1", turnId: current.turnId, sourceCallId: "call_0", goal: "当前目标", createdAt: "2026-09-11" } }]; ledger.currentGoalId = ledger.goals[0]!.id;
    current.goalChanges = structuredClone(ledger.goals);
    const memories: Memories = { project: [], conversation: [] }, provider: Provider = { complete: async input => summaryResponse(input.messages) };
    await compressContext({ dataDir, repoRoot, ledger, turn: current, memories, provider, isCancelled: () => false }, "current");
    const view = contextState(dataDir, ledger, current, memories);
    expect(view.ledger.toolIO).toEqual(ledger.toolIO.slice(2)); expect(view.turn.assembled.pageObservedHistory).toEqual(current.assembled.pageObservedHistory.slice(2));
    expect(view.turn.input).toEqual(current.input); expect(view.turn.assembled.currentPage).toEqual(current.assembled.currentPage); expect(view.ledger.goals.filter(row => row.status === "active")).toEqual(ledger.goals.filter(row => row.status === "active"));
    const index = loadIndex(dataDir, ledger.conversationId, "conversationHistory"), sources = resolveSources(dataDir, ledger.conversationId, "conversationHistory", index.activeIds);
    expect((sources[0]!.content as { toolIO: unknown[] }).toolIO).toHaveLength(2);
    expect((sources[0]!.content as { output: unknown }).output).toBeNull();
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("segmented turn later closes into one active summary without rearchiving covered module increments", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "context-close-segment-"));
  try {
    const ledger = emptyLedger("cv_test"), first = makeTurn(ledger.conversationId, "tn_01");
    ledger.turnIds = [first.turnId]; ledger.active = { turnId: first.turnId };
    first.status = "inferring"; first.completedAt = null; first.output = null;
    ledger.toolIO = Array.from({ length: 3 }, (_, i) => ({ callId: `call_${i}`, turnId: first.turnId, batchId: `batch_${i}`, name: "page.get_summary", arguments: {}, return: { stage: "complete" as const, text: `结果${i}`, totalChars: 3 } }));
    ledger.goals = [{ parentId: null, status: "active", updatedAt: "2026-09-11", ...{ id: "goal_1", turnId: first.turnId, goal: "保持状态", sourceCallId: "call_0", createdAt: "2026-09-11" } }]; ledger.currentGoalId = ledger.goals[0]!.id;
    first.goalChanges = structuredClone(ledger.goals);
    const memories: Memories = { project: [], conversation: [{ memoryId: "mm_1", turnId: first.turnId, layer: "conversation", text: "只改负责人", sourceCallId: "call_0", createdAt: "2026-09-11" }] };
    const provider: Provider = { complete: async input => summaryResponse(input.messages) };
    await compressContext({ dataDir, repoRoot, provider, ledger, turn: first, memories, isCancelled: () => false }, "current");
    first.status = "completed"; first.completedAt = "2026-09-11"; first.output = { kind: "reply", text: "已核对" }; saveTurn(dataDir, first);
    for (let i = 2; i <= 5; i++) { const row = makeTurn(ledger.conversationId, `tn_0${i}`); ledger.turnIds.push(row.turnId); saveTurn(dataDir, row); }
    const current = makeTurn(ledger.conversationId, "tn_06"); ledger.turnIds.push(current.turnId); ledger.active = { turnId: current.turnId };
    // Raise active summary count past the re-compress gate so tn_01 may merge.
    const seeded = loadIndex(dataDir, ledger.conversationId, "conversationHistory");
    while (seeded.activeIds.length <= SUMMARY_RECOMPRESS_MIN_ACTIVE) {
      const id = `sum_pad_${seeded.activeIds.length}`;
      seeded.entries.push({ id, module: "conversationHistory", level: 1, tag: id, turnId: `tn_pad_${seeded.activeIds.length}`, userRequest: "u", actions: "a", result: "r", sourceIds: [], createdAt: "2026-09-11" });
      seeded.activeIds.push(id);
    }
    commitArchive(dataDir, ledger.conversationId, seeded, [], []);
    await compressContext({ dataDir, repoRoot, provider, ledger, turn: current, memories, isCancelled: () => false });
    const index = loadIndex(dataDir, ledger.conversationId, "conversationHistory");
    const realTurnIds = index.activeIds.map(id => index.entries.find(row => row.id === id)!.turnId).filter(id => id.startsWith("tn_0"));
    expect(realTurnIds).toEqual(["tn_01", "tn_02", "tn_03", "tn_04", "tn_05"]);
    const sources = resolveSources(dataDir, ledger.conversationId, "conversationHistory", index.activeIds);
    const tail = sources.find(row => row.id === "src_02")!.content as { toolIO: unknown[]; memoryWrites: unknown[]; goalChanges: unknown[]; output: unknown };
    expect(tail.toolIO).toHaveLength(2); expect(tail.goalChanges).toEqual([]); expect(tail.memoryWrites).toEqual([]);
    expect(tail.output).toEqual({ kind: "reply", text: first.output.kind === "reply" ? first.output.text : "" });
    expect((sources[0]!.content as { segment: { complete: boolean } }).segment.complete).toBe(false);
    expect(contextState(dataDir, ledger, current, memories).ledger.goals).toEqual(ledger.goals);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("200K during a live tool loop compresses older batches before the next main request", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "context-live-boundary-"));
  try {
    let main = 0, aux = 0;
    // Stay under the 4000 inline gate so accumulation, not a single huge return, fills the window.
    const provider: Provider = { complete: async input => {
      if (input.tools[0]?.function.name === "submitTurnSummaries") { aux++; return summaryResponse(input.messages); }
      main++;
      if (main === 4) { expect(aux).toBeGreaterThan(0); expect(input.messages[1]!.content).toContain("<conversationHistorySummary>"); }
      return result({ toolCalls: main <= 3
        ? Array.from({ length: 20 }, (_, i) => ({ id: `p${main}_${i}`, name: "page.get_summary", arguments: { reason: "读取", affectsPage: false, tabId: 1 } }))
        : [{ id: "finish", name: "finishTurn", arguments: { reason: "完成", affectsPage: false, text: "完成"} }] });
    } };
    const reply = await handleTurn({ dataDir, repoRoot, provider, host: { execute: async () => ({
      ok: true, tabId: 1, url: "https://example.com/p", title: "页", description: "证".repeat(3500),
    }) } }, { userInput: "核对结果", submittedAt: "2026-09-11" });
    expect(reply.output).toEqual({ kind: "reply", text: "完成" }); expect(main).toBe(4);
    const ledger = loadLedger(dataDir, reply.conversationId);
    expect(ledger.toolIO).toHaveLength(61);
    expect(loadIndex(dataDir, reply.conversationId, "conversationHistory").coveredSourceIds.length).toBeGreaterThan(0);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("retired query evidence is archived independently of an already-covered tool batch", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "context-retired-query-"));
  try {
    const ledger = emptyLedger("cv_test"), current = makeTurn(ledger.conversationId, "tn_01");
    ledger.turnIds = [current.turnId]; ledger.active = { turnId: current.turnId };
    current.status = "inferring"; current.completedAt = null; current.output = null;
    ledger.toolIO = Array.from({ length: 3 }, (_, i) => ({ callId: `call_0${i + 1}`, turnId: current.turnId, batchId: `batch_0${i + 1}`, name: "context.query", arguments: {}, return: { stage: "complete" as const, text: "查询成功", totalChars: 4 } }));
    ledger.currentQuery = { queryId: "query_01", turnId: current.turnId, sourceCallId: "call_01", sumId: "sum_01", module: "toolIO", intent: "核对历史", status: "complete", records: [{ callId: "call_old", turnId: "tn_old", text: "受保护原文" }] };
    const memories: Memories = { project: [], conversation: [] };
    let requests = 0;
    const provider: Provider = { complete: async input => {
      requests++;
      expect(input.messages[1]!.content.includes("受保护原文")).toBe(requests > 1);
      return summaryResponse(input.messages);
    } };
    const input = { dataDir, repoRoot, provider, ledger, turn: current, memories, isCancelled: () => false };
    await compressContext(input, "current");
    expect(contextState(dataDir, ledger, current, memories).ledger.currentQuery).toEqual(ledger.currentQuery);
    ledger.queryHistory.push(ledger.currentQuery); ledger.currentQuery = null;
    // Its call's batch is already covered; the retired query must still be visible.
    expect(contextState(dataDir, ledger, current, memories).ledger.queryHistory).toHaveLength(1);
    await compressContext(input, "current");
    expect(contextState(dataDir, ledger, current, memories).ledger.queryHistory).toEqual([]);
    expect(ledger.queryHistory).toHaveLength(1);
    const index = loadIndex(dataDir, ledger.conversationId, "conversationHistory");
    // Gate keeps the batch summary; the retired query archives as its own active entry.
    expect(index.activeIds.length).toBe(2);
    const sources = resolveSources(dataDir, ledger.conversationId, "conversationHistory", index.activeIds);
    expect(sources.filter(row => row.id === "src_02")).toHaveLength(1);
    expect((sources.find(row => row.id === "src_02")!.content as { queryHistory: unknown[] }).queryHistory).toEqual(ledger.queryHistory);
    await compressContext(input, "current");
    expect(requests).toBe(2);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("a later retired query remains archivable after its entire turn is covered", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "context-covered-query-"));
  try {
    const ledger = emptyLedger("cv_test"); seed(dataDir, ledger);
    const current = makeTurn(ledger.conversationId, "tn_06");
    ledger.turnIds.push(current.turnId); ledger.active = { turnId: current.turnId };
    const memories: Memories = { project: [], conversation: [] };
    const provider: Provider = { complete: async input => summaryResponse(input.messages) };
    const input = { dataDir, repoRoot, provider, ledger, turn: current, memories, isCancelled: () => false };
    await compressContext(input);
    ledger.queryHistory.push({ queryId: "query_01", turnId: "tn_01", sumId: "sum_01", module: "userInput", intent: "回查要求", status: "complete", records: [{ id: "input_old", turnId: "tn_old", userInput: "只改负责人" }] });
    const snapshot = JSON.stringify(ledger);
    expect(contextState(dataDir, ledger, current, memories).ledger.queryHistory).toHaveLength(1);
    await compressContext(input);
    expect(contextState(dataDir, ledger, current, memories).ledger.queryHistory).toEqual([]);
    expect(JSON.stringify(ledger)).toBe(snapshot);
    const index = loadIndex(dataDir, ledger.conversationId, "conversationHistory");
    const turnIds = index.activeIds.map(id => index.entries.find(row => row.id === id)!.turnId);
    // Original turns plus an extra active summary for the retired query on tn_01.
    expect(turnIds).toEqual(["tn_01", "tn_02", "tn_03", "tn_04", "tn_05", "tn_01"]);
    const sources = resolveSources(dataDir, ledger.conversationId, "conversationHistory", index.activeIds);
    expect(sources.filter(row => row.id === "src_01")).toHaveLength(1);
    expect(sources.filter(row => row.id === "src_03")).toHaveLength(1);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
