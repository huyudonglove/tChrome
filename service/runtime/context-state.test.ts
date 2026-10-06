import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyLedger, ensureSession, loadLedger, loadTurn, primeActiveTask, saveLedger, saveTurn, stopTurn } from "./store.ts";
import { allocateRecordId, inputRecord } from "./ids.ts";
import { contextState, compressContext } from "./context-state.ts";
import { compressionTurnsFromUserMessage } from "../agents/compression/protocol.ts";
import { loadIndex, resolveSources, commitArchive } from "../context-archive/store.ts";
import { SUMMARY_RECOMPRESS_MIN_ACTIVE } from "../agents/compression/index.ts";
import { runtimeConfig } from "../config/runtime.ts";
import { conversationPayload } from "../context/projections/conversation.ts";
import type { Ledger, Turn, Provider, CompletionResult } from "../types.ts";
import type { Memories } from "../memory/types.ts";
import { handleTurn } from "./loop.ts";
import { recordWorkspaceEvidence } from "./workspace.ts";
const repoRoot = join(import.meta.dir, "../..");
// Current-phase archiving keeps the last KEEP_BATCHES batches in the window, so
// fixtures must build one batch more than that to exercise the "older" path.
const KEEP = runtimeConfig.context.keepToolBatches;
const makeTurn = (cv: string, id: string, text = id): Turn => ({ conversationId: cv, turnId: id, status: "completed", createdAt: "2026-09-11", completedAt: "2026-09-11", input: { id: `input_${id}`, text, submittedAt: "2026-09-11" }, assembled: { baseToolsIds: [], toolIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], currentTabs: { ok: true, windows: [] }, currentPage: null, observations: [], workspace: [] }, stopReason: { kind: "reply", text: `完成${id}` } });
const result = (partial: Partial<CompletionResult>): CompletionResult => ({ finish: "tool_calls", content: "", toolCalls: [], attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [], ...partial });
const summaryResponse = (_messages: Parameters<Provider["complete"]>[0]["messages"]) => result({ toolCalls: [{ id: "submit", name: "submitTurnSummaries", arguments: { summary: "历史事项已检查完成。", actions: "已检查", result: "该轮已完成" } }] });
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
    primeActiveTask(dataDir);
  try {
    const ledger = emptyLedger("cv_test"), turns = seed(dataDir, ledger);
    ledger.userInputHistory = turns.map(inputRecord);
    ledger.toolIO = turns.map(turn => ({ callId: `call_${turn.turnId}`, turnId: turn.turnId, batchId: `batch_${turn.turnId}`, name: "memory.write", arguments: {}, return: { stage: "complete", text: "成功", totalChars: 2 } }));
    ledger.notes = { draft: { id: "nt_01", value: "当前草稿" } };
    const memories: Memories = { project: [], conversation: turns.map(turn => ({ memoryId: `mm_${turn.turnId}`, turnId: turn.turnId, layer: "conversation", text: `记忆${turn.turnId}`, createdAt: "2026-09-11", sourceCallId: `call_${turn.turnId}` })) };
    const current = makeTurn(ledger.conversationId, "tn_06"); current.status = "inferring"; current.stopReason = null; current.completedAt = null;
    ledger.turnIds.push(current.turnId); ledger.active = { turnId: current.turnId };
    let calls = 0;
    const provider: Provider = { complete: async input => {
      calls++; expect(input.tools.map(tool => tool.function.name)).toEqual(["submitTurnSummaries"]);
      const source = oneTurnOf(input.messages);
      expect(source.turnId).toBe(`tn_0${calls}`);
      expect((source.memoryWrites as Array<{ turnId: string }>)[0]!.turnId).toBe(source.turnId);
      expect((source.stopReason as { text?: string }).text).toBe(`完成${source.turnId}`);
      return summaryResponse(input.messages);
    } };
    const before = JSON.stringify({ ledger, current, memories });
    await compressContext({ dataDir, repoRoot, provider, ledger, turn: current, memories, isCancelled: () => false });
    const view = contextState(dataDir, ledger, current, memories);
    expect(view.ledger.userInputHistory.map(row => row.turnId)).toEqual([]);
    expect(view.ledger.toolIO).toHaveLength(0); expect(view.memories.conversation).toHaveLength(0);
    expect(view.ledger.notes).toEqual(ledger.notes);
    expect(view.summaries.map(row => row.turnId)).toEqual(["tn_01", "tn_02", "tn_03", "tn_04", "tn_05"]);
    expect(JSON.stringify({ ledger, current, memories })).toBe(before);
    await compressContext({ dataDir, repoRoot, provider, ledger, turn: current, memories, isCancelled: () => false });
    expect(calls).toBe(5);
    expect(loadIndex(dataDir, ledger.conversationId, "conversationHistory").coveredSourceIds).toEqual(["src_01", "src_02", "src_03", "src_04", "src_05"]);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

for (const fail of [false, true]) test(`sequential 200K walk archives prefix; failure=${fail} keeps later originals and continues main`, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "context-boundary-"));
    primeActiveTask(dataDir);
  try {
    const session = ensureSession(dataDir), ledger = loadLedger(dataDir, session.conversationId); seed(dataDir, ledger, 5, true); saveLedger(dataDir, ledger); primeActiveTask(dataDir);
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
      return result({ toolCalls: [{ id: "finish", name: "finishTurn", arguments: { reason: "完成", text: "完成"} }] });
    } };
    const reply = await handleTurn({ dataDir, repoRoot, provider }, { userInput: "继续", submittedAt: "2026-09-11" });
    expect(reply.stopReason).toEqual({ kind: "reply", text: "完成" });
    expect(main).toBe(1);
    expect(aux).toBe(fail ? 3 : 5);
    expect(loadLedger(dataDir, session.conversationId).userInputHistory).toHaveLength(5);
    expect(loadIndex(dataDir, session.conversationId, "conversationHistory").coveredSourceIds).toEqual(fail ? ["src_01", "src_02"] : ["src_01", "src_02", "src_03", "src_04", "src_05"]);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("below 200K no compression request occurs at turn boundary", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "context-below-"));
    primeActiveTask(dataDir);
  try {
    const session = ensureSession(dataDir), ledger = loadLedger(dataDir, session.conversationId); seed(dataDir, ledger); saveLedger(dataDir, ledger); primeActiveTask(dataDir);
    const provider: Provider = { complete: async input => { expect(input.tools[0]!.function.name).not.toBe("submitTurnSummaries"); return result({ toolCalls: [{ id: "finish", name: "finishTurn", arguments: { reason: "完成", text: "完成"} }] }); } };
    await handleTurn({ dataDir, repoRoot, provider }, { userInput: "继续", submittedAt: "2026-09-11" });
    expect(loadIndex(dataDir, session.conversationId, "conversationHistory").activeIds).toEqual([]);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("stop during batched compression cannot commit coverage or overwrite paused session", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "context-stop-"));
    primeActiveTask(dataDir);
  try {
    const session = ensureSession(dataDir), ledger = loadLedger(dataDir, session.conversationId); seed(dataDir, ledger, 5, true); saveLedger(dataDir, ledger); primeActiveTask(dataDir);
    let release!: () => void, started!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
    const provider: Provider = { complete: async input => { started(); await pending; return summaryResponse(input.messages); } };
    const running = handleTurn({ dataDir, repoRoot, provider }, { userInput: "继续", submittedAt: "2026-09-11" });
    await entered; stopTurn(dataDir); release();
    expect((await running).stopReason).toEqual({ kind: "interrupted", initiatedBy: "user" });
    expect(loadLedger(dataDir, session.conversationId).status).toBe("paused");
    expect(loadIndex(dataDir, session.conversationId, "conversationHistory").coveredSourceIds).toEqual([]);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("long current turn archives retained and transient calls while keeping the latest batches", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "context-segment-"));
    primeActiveTask(dataDir);
  try {
    const ledger = emptyLedger("cv_test"), current = makeTurn(ledger.conversationId, "tn_01");
    current.status = "inferring"; current.stopReason = null; current.completedAt = null; ledger.turnIds = [current.turnId]; ledger.active = { turnId: current.turnId };
    ledger.toolIO = Array.from({ length: KEEP * 2 + 2 }, (_, i) => ({ callId: `call_${i}`, turnId: current.turnId, batchId: `b_${Math.floor(i / 2)}`, name: "page_get_summary", arguments: { keepInCalls: i % 2 === 0 }, return: { stage: "complete" as const, text: "结果", totalChars: 2 } }));
    current.assembled.observations = ledger.toolIO.map((row, i) => ({ id: `p_${i}`, turnId: current.turnId, callId: row.callId, observedAt: "2026-09-11", type: row.name, result: { ok: true, tabId: 1, url: "https://example.com", title: "页面", state: `状态${i}` } }));
    current.assembled.currentPage = { tabId: 1, url: "https://example.com", title: "页面", description: "状态5" };
    const memories: Memories = { project: [], conversation: [] }, provider: Provider = { complete: async input => summaryResponse(input.messages) };
    const visibleCalls = (sourceLedger: Ledger, sourceTurn: Turn) => conversationPayload({ ledger: sourceLedger, turn: sourceTurn, memories, gate: { inlineChars: runtimeConfig.results.inlineChars } }).turns.flatMap(row => row.calls.map(call => call.callId));
    expect(visibleCalls(ledger, current)).toContain("call_0");
    expect(visibleCalls(ledger, current)).not.toContain("call_1");
    await compressContext({ dataDir, repoRoot, ledger, turn: current, memories, provider, isCancelled: () => false }, "current");
    const view = contextState(dataDir, ledger, current, memories);
    expect(visibleCalls(view.ledger, view.turn)).not.toContain("call_0");
    expect(view.ledger.toolIO).toEqual(ledger.toolIO.slice(2)); expect(view.turn.assembled.observations).toEqual(current.assembled.observations.slice(2));
    expect(view.turn.input).toEqual(current.input); expect(view.turn.assembled.currentPage).toEqual(current.assembled.currentPage);
    const index = loadIndex(dataDir, ledger.conversationId, "conversationHistory"), sources = resolveSources(dataDir, ledger.conversationId, "conversationHistory", index.activeIds);
    expect((sources[0]!.content as { toolIO: unknown[] }).toolIO).toEqual(ledger.toolIO.slice(0, 2));
    expect((sources[0]!.content as { stopReason: unknown }).stopReason).toBeNull();
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("automatic workspace evidence reloads old turns and archives alongside source calls", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "context-workspace-"));
  primeActiveTask(dataDir);
  try {
    const ledger = emptyLedger("cv_test");
    const previous = makeTurn(ledger.conversationId, "tn_01");
    const current = makeTurn(ledger.conversationId, "tn_02");
    current.status = "inferring"; current.completedAt = null; current.stopReason = null;
    ledger.turnIds = [previous.turnId, current.turnId];
    ledger.userInputHistory = [inputRecord(previous)];
    ledger.active = { turnId: current.turnId };
    for (let i = 0; i < KEEP + 2; i++) {
      const turn = i === 0 ? previous : current;
      const text = JSON.stringify({ ok: true, path: `/src/${i}.ts`, content: `source ${i}` });
      const row = { callId: `call_0${i + 1}`, turnId: turn.turnId, batchId: `batch_0${i + 1}`, name: "local_fs_read", arguments: { items: [{ path: `/src/${i}.ts` }] }, return: { stage: "complete" as const, text, totalChars: text.length } };
      ledger.toolIO.push(row);
      ledger.boundSeq = i + 1;
      recordWorkspaceEvidence(dataDir, ledger, turn, row);
    }
    saveTurn(dataDir, previous); saveTurn(dataDir, current); saveLedger(dataDir, ledger);
    const reloaded = loadLedger(dataDir, ledger.conversationId);
    const live = loadTurn(dataDir, ledger.conversationId, current.turnId);
    const memories: Memories = { project: [], conversation: [] };
    const expected = [...previous.assembled.workspace, ...current.assembled.workspace];
    expect(contextState(dataDir, reloaded, live, memories).turn.assembled.workspace).toEqual(expected);
    const provider: Provider = { complete: async input => {
      const source = oneTurnOf(input.messages);
      expect(source.workspace).toEqual(current.assembled.workspace.slice(0, 1));
      return summaryResponse(input.messages);
    } };
    await compressContext({ dataDir, repoRoot, provider, ledger: reloaded, turn: live, memories, isCancelled: () => false }, "current");
    const view = contextState(dataDir, loadLedger(dataDir, ledger.conversationId), loadTurn(dataDir, ledger.conversationId, current.turnId), memories);
    expect(view.turn.assembled.workspace).toEqual([...previous.assembled.workspace, ...current.assembled.workspace.slice(1)]);
    const index = loadIndex(dataDir, ledger.conversationId, "conversationHistory");
    const sources = resolveSources(dataDir, ledger.conversationId, "conversationHistory", index.activeIds);
    expect((sources[0]!.content as { workspace: unknown }).workspace).toEqual(current.assembled.workspace.slice(0, 1));
    expect((sources[0]!.content as { toolIO: unknown }).toolIO).toEqual(ledger.toolIO.slice(1, 2));
    expect(loadTurn(dataDir, ledger.conversationId, current.turnId).assembled.workspace).toEqual(current.assembled.workspace);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("segmented turn later closes into one active summary without rearchiving covered module increments", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "context-close-segment-"));
    primeActiveTask(dataDir);
  try {
    const ledger = emptyLedger("cv_test"), first = makeTurn(ledger.conversationId, "tn_01");
    ledger.turnIds = [first.turnId]; ledger.active = { turnId: first.turnId };
    first.status = "inferring"; first.completedAt = null; first.stopReason = null;
    ledger.toolIO = Array.from({ length: KEEP + 1 }, (_, i) => ({ callId: `call_${i}`, turnId: first.turnId, batchId: `batch_${i}`, name: "page_get_summary", arguments: {}, return: { stage: "complete" as const, text: `结果${i}`, totalChars: 3 } }));
    const memories: Memories = { project: [], conversation: [{ memoryId: "mm_1", turnId: first.turnId, layer: "conversation", text: "只改负责人", sourceCallId: "call_0", createdAt: "2026-09-11" }] };
    const provider: Provider = { complete: async input => summaryResponse(input.messages) };
    await compressContext({ dataDir, repoRoot, provider, ledger, turn: first, memories, isCancelled: () => false }, "current");
    first.status = "completed"; first.completedAt = "2026-09-11"; first.stopReason = { kind: "reply", text: "已核对" }; saveTurn(dataDir, first);
    for (let i = 2; i <= 5; i++) { const row = makeTurn(ledger.conversationId, `tn_0${i}`); ledger.turnIds.push(row.turnId); saveTurn(dataDir, row); }
    const current = makeTurn(ledger.conversationId, "tn_06"); ledger.turnIds.push(current.turnId); ledger.active = { turnId: current.turnId };
    // Raise active summary count past the re-compress gate so tn_01 may merge.
    const seeded = loadIndex(dataDir, ledger.conversationId, "conversationHistory");
    while (seeded.activeIds.length <= SUMMARY_RECOMPRESS_MIN_ACTIVE) {
      const id = `sum_pad_${seeded.activeIds.length}`;
      seeded.entries.push({ id, module: "conversationHistory", level: 1, summary: id, turnId: `tn_pad_${seeded.activeIds.length}`, userRequest: "u", actions: "a", result: "r", sourceIds: [], createdAt: "2026-09-11" });
      seeded.activeIds.push(id);
    }
    commitArchive(dataDir, ledger.conversationId, seeded, [], []);
    await compressContext({ dataDir, repoRoot, provider, ledger, turn: current, memories, isCancelled: () => false });
    const index = loadIndex(dataDir, ledger.conversationId, "conversationHistory");
    // Cross-turn folding may replace per-turn L1 rows with span records; assert the
    // original turns are still covered by the active summary set.
    const activeRows = index.activeIds.map((id) => index.entries.find((row) => row.id === id)!);
    const coveredTurns = new Set(activeRows.flatMap((row) => row.turnIds ?? [row.turnId]));
    for (const turnId of ["tn_01", "tn_02", "tn_03", "tn_04", "tn_05"]) expect(coveredTurns.has(turnId)).toBe(true);
    const sources = resolveSources(dataDir, ledger.conversationId, "conversationHistory", index.activeIds);
    const tail = sources.find(row => row.id === "src_02")!.content as { toolIO: unknown[]; memoryWrites: unknown[]; stopReason: unknown };
    // One call per batch: the KEEP newest batches are held in window until the turn
    // itself is archived, so the turn-level source carries exactly KEEP rows.
    expect(tail.toolIO).toHaveLength(KEEP); expect(tail.memoryWrites).toEqual([]);
    expect(tail.stopReason).toEqual({ kind: "reply", text: first.stopReason.kind === "reply" ? first.stopReason.text : "" });
    expect((sources[0]!.content as { segment: { complete: boolean } }).segment.complete).toBe(false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("200K during a live tool loop compresses older batches before the next main request", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "context-live-boundary-"));
    primeActiveTask(dataDir);
  try {
    // Lower the threshold to exercise live compression with bounded test data.
    const primed = loadLedger(dataDir, ensureSession(dataDir).conversationId);
    primed.compressAt = 40000;
    saveLedger(dataDir, primed);
    let main = 0, aux = 0;
    // Stay under the single-return inline gate so accumulation, not a single huge return, fills the window.
    const provider: Provider = { complete: async input => {
      if (input.tools[0]?.function.name === "submitTurnSummaries") { aux++; return summaryResponse(input.messages); }
      main++;
      if (main === KEEP + 2) { expect(aux).toBeGreaterThan(0); expect(input.messages[1]!.content).toContain("<summary"); }
      return result({ toolCalls: main <= KEEP + 1
        ? [
            ...(main > 1 ? [{ id: `c${main}`, name: "page_click", arguments: { reason: "继续" } }] : []),
            ...Array.from({ length: main > 1 ? 19 : 20 }, (_, i) => ({ id: `p${main}_${i}`, name: "page_get_summary", arguments: { reason: "读取", tabId: 1 } })),
          ]
        : [{ id: "finish", name: "finishTurn", arguments: { reason: "完成", text: "完成"} }] });
    } };
    let hostCall = 0;
    const reply = await handleTurn({ dataDir, repoRoot, provider, host: { execute: async () => ({
      ok: true, tabId: 1, url: "https://example.com/p", title: "页", description: `${++hostCall}:` + "证".repeat(3500),
    }) } }, { userInput: "核对结果", submittedAt: "2026-09-11" });
    expect(reply.stopReason).toEqual({ kind: "reply", text: "完成" }); expect(main).toBe(KEEP + 2);
    const ledger = loadLedger(dataDir, reply.conversationId);
    expect(ledger.toolIO).toHaveLength((KEEP + 1) * 20 + 1);
    expect(loadIndex(dataDir, reply.conversationId, "conversationHistory").coveredSourceIds.length).toBeGreaterThan(0);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("query evidence is archived independently of an already-covered tool batch", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "context-retired-query-"));
    primeActiveTask(dataDir);
  try {
    const ledger = emptyLedger("cv_test"), current = makeTurn(ledger.conversationId, "tn_01");
    ledger.turnIds = [current.turnId]; ledger.active = { turnId: current.turnId };
    current.status = "inferring"; current.completedAt = null; current.stopReason = null;
    ledger.toolIO = Array.from({ length: KEEP + 1 }, (_, i) => ({ callId: `call_0${i + 1}`, turnId: current.turnId, batchId: `batch_0${i + 1}`, name: "context_query", arguments: {}, return: { stage: "complete" as const, text: "查询成功", totalChars: 4 } }));
    // 反复查询直接塞进数组，没有 current 位。
    ledger.queryHistory.push({ queryId: "query_01", turnId: current.turnId, sourceCallId: "call_01", sumId: "sum_01", module: "toolIO", intent: "核对历史", status: "complete", records: [{ callId: "call_old", turnId: "tn_old", text: "受保护原文" }] });
    const memories: Memories = { project: [], conversation: [] };
    const provider: Provider = { complete: async input => summaryResponse(input.messages) };
    const input = { dataDir, repoRoot, provider, ledger, turn: current, memories, isCancelled: () => false };
    await compressContext(input, "current");
    // 其调用所在批已被覆盖，query 照样进归档、窗口不再携带、账本保留。
    expect(contextState(dataDir, ledger, current, memories).ledger.queryHistory).toEqual([]);
    expect(ledger.queryHistory).toHaveLength(1);
    const index = loadIndex(dataDir, ledger.conversationId, "conversationHistory");
    expect(index.activeIds.length).toBe(1);
    const sources = resolveSources(dataDir, ledger.conversationId, "conversationHistory", index.activeIds);
    const archived = sources.flatMap(row => (row.content as { queryHistory?: unknown[] }).queryHistory ?? []);
    expect(archived).toHaveLength(1);
    expect(JSON.stringify(archived[0])).toContain("受保护原文");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("a later query remains archivable after its entire turn is covered", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "context-covered-query-"));
    primeActiveTask(dataDir);
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
    // Original turns plus an extra active summary for the query on tn_01.
    expect(turnIds).toEqual(["tn_01", "tn_02", "tn_03", "tn_04", "tn_05", "tn_01"]);
    const sources = resolveSources(dataDir, ledger.conversationId, "conversationHistory", index.activeIds);
    expect(sources.filter(row => row.id === "src_01")).toHaveLength(1);
    expect(sources.filter(row => row.id === "src_03")).toHaveLength(1);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
