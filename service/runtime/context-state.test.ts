import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyLedger, saveTurn, ensureSession, saveLedger, loadLedger, stopTurn } from "./store.ts";
import { inputRecord } from "./ids.ts";
import { contextState, compressContext } from "./context-state.ts";
import { loadIndex, resolveSources } from "../context-archive/store.ts";
import type { Ledger, Turn, Provider, CompletionResult } from "../types.ts";
import type { Memories } from "../memory/types.ts";
import { handleTurn } from "./loop.ts";
const repoRoot = join(import.meta.dir, "../..");
const makeTurn = (cv: string, id: string, text = id): Turn => ({ conversationId: cv, turnId: id, status: "completed", createdAt: "2026-09-11", completedAt: "2026-09-11", input: { id: `input_${id}`, text, submittedAt: "2026-09-11" }, assembled: { baseToolsIds: [], toolIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], currentTab: null, currentPage: null, pageObservedHistory: [] }, output: { kind: "reply", text: `完成${id}` } });
const result = (partial: Partial<CompletionResult>): CompletionResult => ({ finish: "tool_calls", content: "", toolCalls: [], attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [], ...partial });
const summaryResponse = (messages: Parameters<Provider["complete"]>[0]["messages"]) => result({ toolCalls: [{ id: "submit", name: "submitTurnSummaries", arguments: { summaries: JSON.parse(messages[1]!.content).turns.map((turn: { turnId: string }) => ({ turnId: turn.turnId, tag: "历史事项", userRequest: "此前要求", actions: "已检查", result: "该轮已完成" })) } }] });
function seed(dataDir: string, ledger: Ledger, count = 5, big = false) {
  const turns = Array.from({ length: count }, (_, i) => makeTurn(ledger.conversationId, `tn_0${i + 1}`, big ? "原始要求".repeat(12000) : `要求${i}`));
  ledger.turnIds = turns.map(turn => turn.turnId);
  ledger.userInputHistory = turns.slice(0, -1).map(inputRecord);
  turns.forEach(turn => saveTurn(dataDir, turn));
  return turns;
}

test("whole-turn grouping removes covered module increments, retaining current state and three recent turns", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "context-turns-"));
  try {
    const ledger = emptyLedger("cv_test"), turns = seed(dataDir, ledger);
    ledger.userInputHistory = turns.map(inputRecord);
    ledger.toolIO = turns.map(turn => ({ callId: `call_${turn.turnId}`, turnId: turn.turnId, batchId: `batch_${turn.turnId}`, name: "memory.write", arguments: {}, return: { stage: "complete", text: "成功", totalChars: 2 } }));
    ledger.goalHistory = turns.map(turn => ({ id: `goal_${turn.turnId}`, turnId: turn.turnId, goal: `目标${turn.turnId}`, sourceCallId: `call_${turn.turnId}`, createdAt: "2026-09-11" }));
    ledger.goal = ledger.goalHistory.shift()!;
    ledger.notes = { draft: "当前草稿" };
    const memories: Memories = { project: [], conversation: turns.map(turn => ({ memoryId: `mm_${turn.turnId}`, turnId: turn.turnId, layer: "conversation", text: `记忆${turn.turnId}`, createdAt: "2026-09-11", sourceCallId: `call_${turn.turnId}` })) };
    const current = makeTurn(ledger.conversationId, "tn_06"); current.status = "inferring"; current.output = null; current.completedAt = null;
    ledger.turnIds.push(current.turnId); ledger.active = { turnId: current.turnId };
    let calls = 0;
    const provider: Provider = { complete: async input => {
      calls++; expect(input.tools.map(tool => tool.function.name)).toEqual(["submitTurnSummaries"]);
      const sources = JSON.parse(input.messages[1]!.content).turns;
      expect(sources.map((row: Turn) => row.turnId)).toEqual(["tn_01", "tn_02"]);
      expect(sources[0].memoryWrites[0].turnId).toBe("tn_01");
      expect(sources[0].output.text).toBe("完成tn_01");
      return summaryResponse(input.messages);
    } };
    const before = JSON.stringify({ ledger, current, memories });
    await compressContext({ dataDir, repoRoot, provider, ledger, turn: current, memories, isCancelled: () => false });
    const view = contextState(dataDir, ledger, current, memories);
    expect(view.ledger.userInputHistory.map(row => row.turnId)).toEqual(["tn_03", "tn_04", "tn_05"]);
    expect(view.ledger.goalHistory.map(row => row.turnId)).toEqual(["tn_03", "tn_04", "tn_05"]);
    expect(view.ledger.toolIO).toHaveLength(3); expect(view.memories.conversation).toHaveLength(3);
    expect(view.ledger.goal).toEqual(ledger.goal); expect(view.ledger.notes).toEqual(ledger.notes);
    expect(view.summaries.map(row => row.turnId)).toEqual(["tn_01", "tn_02"]);
    expect(JSON.stringify({ ledger, current, memories })).toBe(before);
    await compressContext({ dataDir, repoRoot, provider, ledger, turn: current, memories, isCancelled: () => false });
    expect(calls).toBe(1);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

for (const fail of [false, true]) test(`single 200K send gate batches old turns; failure=${fail} retains originals`, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "context-boundary-"));
  try {
    const session = ensureSession(dataDir), ledger = loadLedger(dataDir, session.conversationId); seed(dataDir, ledger, 5, true); saveLedger(dataDir, ledger);
    let main = 0, aux = 0;
    const provider: Provider = { complete: async input => {
      if (input.tools[0]?.function.name === "submitTurnSummaries") { aux++; return fail ? result({ finish: "error", faultCode: "test_error" }) : summaryResponse(input.messages); }
      main++; expect(aux).toBeGreaterThan(0); expect(input.messages[1]!.content).toContain("该轮已完成");
      expect(input.messages[1]!.content).not.toContain("#toolIOSummary");
      return result({ toolCalls: [{ id: "finish", name: "finishTurn", arguments: { reason: "完成", affectsPage: false, text: "完成" } }] });
    } };
    const reply = await handleTurn({ dataDir, repoRoot, provider }, { userInput: "继续", submittedAt: "2026-09-11" });
    expect(reply.output).toEqual(fail ? { kind: "error", faultCode: "compression_failed" } : { kind: "reply", text: "完成" });
    expect(main).toBe(fail ? 0 : 1);
    expect(loadLedger(dataDir, session.conversationId).userInputHistory).toHaveLength(5);
    expect(loadIndex(dataDir, session.conversationId, "conversationHistory").coveredSourceIds.length).toBe(fail ? 0 : 2);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("below 200K no compression request occurs at turn boundary", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "context-below-"));
  try {
    const session = ensureSession(dataDir), ledger = loadLedger(dataDir, session.conversationId); seed(dataDir, ledger); saveLedger(dataDir, ledger);
    const provider: Provider = { complete: async input => { expect(input.tools[0]!.function.name).not.toBe("submitTurnSummaries"); return result({ toolCalls: [{ id: "finish", name: "finishTurn", arguments: { reason: "完成", affectsPage: false, text: "完成" } }] }); } };
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
    current.assembled.pageObservedHistory = ledger.toolIO.map((row, i) => ({ id: `p_${i}`, turnId: current.turnId, callId: row.callId, toolName: row.name, tab: 1, url: "https://example.com", title: "页面", description: `状态${i}`, observedAt: "2026-09-11" }));
    current.assembled.currentPage = current.assembled.pageObservedHistory[5]!;
    ledger.goal = { id: "goal_1", turnId: current.turnId, sourceCallId: "call_0", goal: "当前目标", createdAt: "2026-09-11" };
    const memories: Memories = { project: [], conversation: [] }, provider: Provider = { complete: async input => summaryResponse(input.messages) };
    await compressContext({ dataDir, repoRoot, ledger, turn: current, memories, provider, isCancelled: () => false }, "current");
    const view = contextState(dataDir, ledger, current, memories);
    expect(view.ledger.toolIO).toEqual(ledger.toolIO.slice(2)); expect(view.turn.assembled.pageObservedHistory).toEqual(current.assembled.pageObservedHistory.slice(2));
    expect(view.turn.input).toEqual(current.input); expect(view.turn.assembled.currentPage).toEqual(current.assembled.currentPage); expect(view.ledger.goal).toEqual(ledger.goal);
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
    ledger.goal = { id: "goal_1", turnId: first.turnId, goal: "保持状态", sourceCallId: "call_0", createdAt: "2026-09-11" };
    const memories: Memories = { project: [], conversation: [{ memoryId: "mm_1", turnId: first.turnId, layer: "conversation", text: "只改负责人", sourceCallId: "call_0", createdAt: "2026-09-11" }] };
    const provider: Provider = { complete: async input => summaryResponse(input.messages) };
    await compressContext({ dataDir, repoRoot, provider, ledger, turn: first, memories, isCancelled: () => false }, "current");
    first.status = "completed"; first.completedAt = "2026-09-11"; first.output = { kind: "reply", text: "已核对" }; saveTurn(dataDir, first);
    for (let i = 2; i <= 5; i++) { const row = makeTurn(ledger.conversationId, `tn_0${i}`); ledger.turnIds.push(row.turnId); saveTurn(dataDir, row); }
    const current = makeTurn(ledger.conversationId, "tn_06"); ledger.turnIds.push(current.turnId); ledger.active = { turnId: current.turnId };
    await compressContext({ dataDir, repoRoot, provider, ledger, turn: current, memories, isCancelled: () => false });
    const index = loadIndex(dataDir, ledger.conversationId, "conversationHistory");
    expect(index.activeIds.map(id => index.entries.find(row => row.id === id)!.turnId)).toEqual(["tn_01", "tn_02"]);
    const sources = resolveSources(dataDir, ledger.conversationId, "conversationHistory", index.activeIds);
    const tail = sources.find(row => row.id === "turn_tn_01")!.content as { toolIO: unknown[]; memoryWrites: unknown[]; goalChanges: unknown[]; output: unknown };
    expect(tail.toolIO).toHaveLength(2); expect(tail.goalChanges).toEqual([]); expect(tail.memoryWrites).toEqual([]); expect(tail.output).toEqual(first.output);
    expect((sources[0]!.content as { segment: { complete: boolean } }).segment.complete).toBe(false);
    expect(contextState(dataDir, ledger, current, memories).ledger.goal).toEqual(ledger.goal);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("200K during a live tool loop compresses older batches before the next main request", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "context-live-boundary-"));
  try {
    let main = 0, aux = 0;
    const provider: Provider = { complete: async input => {
      if (input.tools[0]?.function.name === "submitTurnSummaries") { aux++; return summaryResponse(input.messages); }
      main++;
      if (main === 4) { expect(aux).toBeGreaterThan(0); expect(input.messages[1]!.content).toContain("#conversationHistorySummary"); }
      return result({ toolCalls: main <= 3
        ? [{ id: `page_${main}`, name: "page.get_summary", arguments: { reason: "读取", affectsPage: false } }]
        : [{ id: "finish", name: "finishTurn", arguments: { reason: "完成", affectsPage: false, text: "完成" } }] });
    } };
    const reply = await handleTurn({ dataDir, repoRoot, provider, host: { execute: async () => ({ ok: true, text: "证据".repeat(40000) }) } }, { userInput: "核对结果", submittedAt: "2026-09-11" });
    expect(reply.output).toEqual({ kind: "reply", text: "完成" }); expect(main).toBe(4);
    const ledger = loadLedger(dataDir, reply.conversationId);
    expect(ledger.toolIO).toHaveLength(4);
    expect(loadIndex(dataDir, reply.conversationId, "conversationHistory").coveredSourceIds).toHaveLength(1);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
