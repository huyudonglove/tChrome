import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionResult, Provider, Turn, LoopRecord } from "../types.ts";
import { commitArchive, loadIndex } from "../context-archive/store.ts";
import { handleTurn } from "./loop.ts";
import { allocateRecordId, inputRecord } from "./ids.ts";
import { deleteConversation, ensureSession, listConversationIds, loadLedger, loadTurn, newConversation, openConversation, saveLedger, saveTurn, stopTurn } from "./store.ts";

const repoRoot = join(import.meta.dir, "../..");
const body = { userInput: "继续", submittedAt: "2026-09-12" };
const completion = (toolCalls: CompletionResult["toolCalls"]): CompletionResult => ({ content: "", finish: "tool_calls", toolCalls, attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [] });
const finish = (text = "完成") => completion([{ id: "finish", name: "finishTurn", arguments: { reason: "已完成", text } }]);
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Cancellation did not settle promptly")), 1000); })]); }
  finally { clearTimeout(timer!); }
}
function aborted(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) return Promise.reject(new Error("Missing shared cancellation signal"));
  return new Promise((_, reject) => {
    const cancel = () => reject(new DOMException("Stopped", "AbortError"));
    if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true });
  });
}
function seed(dataDir: string, large = false) {
  const { conversationId: cv } = ensureSession(dataDir), ledger = loadLedger(dataDir, cv);
  const turns = Array.from({ length: 5 }, (_, i): Turn => ({ conversationId: cv, turnId: allocateRecordId(dataDir, cv, "turn"), status: "completed", createdAt: "2026-09-12", completedAt: "2026-09-12", input: { id: `input_0${i + 1}`, text: large ? "历史要求".repeat(12000) : `历史要求${i}`, submittedAt: "2026-09-12" }, assembled: { baseToolsIds: [], toolIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], currentTabs: { ok: true, windows: [] }, currentPage: null, observations: [] }, stopReason: { kind: "reply", text: "完成" } }));
  ledger.turnIds = turns.map(turn => turn.turnId); ledger.userInputHistory = turns.slice(0, -1).map(inputRecord);
  turns.forEach(turn => saveTurn(dataDir, turn));
  ledger.loops = turns.map((turn): LoopRecord => ({
    id: allocateRecordId(dataDir, cv, "loop"), conversationId: cv, turnId: turn.turnId,
    createdAt: turn.createdAt, sentAt: turn.createdAt, completedAt: turn.completedAt!,
    runtime: [{ id: allocateRecordId(dataDir, cv, "runtime"), type: "userInput", content: turn.input.text }],
    helm: { id: allocateRecordId(dataDir, cv, "helm"), content: "完成", calls: [], finish: "stop" },
  }));
  saveLedger(dataDir, ledger);
  return { cv, turns, loops: ledger.loops };
}

test("stopping a main request aborts its signal and returns stopped without persisting a provider error", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "model-stop-main-")), entered = deferred<AbortSignal | undefined>();
  try {
    let calls = 0;
    const provider: Provider = { complete: input => { calls++; entered.resolve(input.signal); return aborted(input.signal); } };
    const running = handleTurn({ dataDir, repoRoot, provider }, body), signal = await within(entered.promise);
    expect(signal).toBeInstanceOf(AbortSignal); stopTurn(dataDir);
    expect(signal!.aborted).toBe(true);
    const reply = await within(running);
    expect(reply.stopReason).toEqual({ kind: "interrupted", initiatedBy: "user" }); expect(calls).toBe(1);
    expect(loadLedger(dataDir, reply.conversationId).status).toBe("paused");
    expect(loadTurn(dataDir, reply.conversationId, reply.turnId).stopReason).toEqual(reply.stopReason);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("stopping compression aborts the auxiliary model and leaves archive coverage uncommitted", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "model-stop-compression-")), entered = deferred<AbortSignal | undefined>();
  try {
    const { cv } = seed(dataDir, true);
    const provider: Provider = { complete: input => { expect(input.tools[0]?.function.name).toBe("submitLoopSummaries"); entered.resolve(input.signal); return aborted(input.signal); } };
    const running = handleTurn({ dataDir, repoRoot, provider }, body), signal = await within(entered.promise);
    stopTurn(dataDir); expect(signal?.aborted).toBe(true);
    expect((await within(running)).stopReason).toEqual({ kind: "interrupted", initiatedBy: "user" });
    expect(loadLedger(dataDir, cv).status).toBe("paused");
    expect(loadIndex(dataDir, cv, "conversationHistory").coveredSourceIds).toEqual([]);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("query uses the main request's signal and cancellation cannot install query evidence", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "model-stop-query-")), entered = deferred<AbortSignal | undefined>();
  try {
    const { cv, loops } = seed(dataDir);
    const summary = { id: "sum_01", module: "conversationHistory" as const, level: 1, loopIds: [loops[0]!.id], summary: "历史要求已处理。", userRequest: "要求", actions: "已处理", result: "已完成", sourceIds: [loops[0]!.id], createdAt: "2026-09-12" };
    commitArchive(dataDir, cv, { version: 1, module: "conversationHistory", entries: [summary], activeIds: [summary.id], coveredSourceIds: summary.sourceIds }, [{ id: loops[0]!.id, content: loops[0]! }], [summary]);
    let mainSignal: AbortSignal | undefined, mainCalls = 0;
    const provider: Provider = { complete: async input => {
      if (input.tools[0]?.function.name === "submitMatches") { expect(input.signal).toBe(mainSignal); entered.resolve(input.signal); return aborted(input.signal); }
      mainCalls++; mainSignal = input.signal;
      return completion([{ id: "query", name: "context_query", arguments: { reason: "核对历史", sumId: summary.id, module: "runtime", intent: "读取要求" } }]);
    } };
    const running = handleTurn({ dataDir, repoRoot, provider }, body), signal = await within(entered.promise);
    stopTurn(dataDir); expect(signal?.aborted).toBe(true);
    expect((await within(running)).stopReason).toEqual({ kind: "interrupted", initiatedBy: "user" });
    const ledger = loadLedger(dataDir, cv);
    expect(ledger.loops.flatMap(loop => loop.runtime).filter(row => row.type === "callsResult")).toEqual([]); expect(mainCalls).toBe(1);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("a replacement turn has its own signal and ignores a stopped provider's late response", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "model-stop-replace-")), entered = deferred<AbortSignal | undefined>(), late = deferred<CompletionResult>();
  try {
    let signalB: AbortSignal | undefined;
    const a = handleTurn({ dataDir, repoRoot, provider: { complete: input => { entered.resolve(input.signal); return late.promise; } } }, body);
    const signalA = await within(entered.promise); stopTurn(dataDir);
    expect((await within(a)).stopReason).toEqual({ kind: "interrupted", initiatedBy: "user" });
    const b = await handleTurn({ dataDir, repoRoot, provider: { complete: async input => { signalB = input.signal; return finish("新轮结果"); } } }, body);
    expect(signalB).toBeInstanceOf(AbortSignal); expect(signalB).not.toBe(signalA); expect(signalA?.aborted).toBe(true);
    expect(b.stopReason).toEqual({ kind: "reply", text: "新轮结果" });
    late.resolve(finish("旧轮迟到结果")); await Promise.resolve(); await Promise.resolve();
    expect(loadTurn(dataDir, b.conversationId, b.turnId).stopReason).toEqual(b.stopReason);
    expect(loadLedger(dataDir, b.conversationId).turnIds.at(-1)).toBe(b.turnId);
  } finally { late.resolve(finish()); rmSync(dataDir, { recursive: true, force: true }); }
});

test("new/open conversation preserves running requests and deleting a conversation cancels only its request", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "model-stop-delete-")), enteredA = deferred<AbortSignal | undefined>(), enteredB = deferred<AbortSignal | undefined>();
  try {
    const cvA = ensureSession(dataDir).conversationId;
    const a = handleTurn({ dataDir, repoRoot, provider: { complete: input => { enteredA.resolve(input.signal); return aborted(input.signal); } } }, body);
    const signalA = await within(enteredA.promise), cvB = newConversation(dataDir).conversationId!;
    expect(signalA?.aborted).toBe(false);
    const b = handleTurn({ dataDir, repoRoot, provider: { complete: input => { enteredB.resolve(input.signal); return aborted(input.signal); } } }, body);
    const signalB = await within(enteredB.promise);
    openConversation(dataDir, cvA); openConversation(dataDir, cvB);
    expect(signalA?.aborted).toBe(false); expect(signalB?.aborted).toBe(false);
    deleteConversation(dataDir, cvA);
    expect(signalA?.aborted).toBe(true); expect(signalB?.aborted).toBe(false);
    expect((await within(a)).stopReason).toEqual({ kind: "interrupted", initiatedBy: "user" });
    expect(listConversationIds(dataDir)).not.toContain(cvA);
    expect(loadLedger(dataDir, cvB).status).toBe("running");
    stopTurn(dataDir); expect((await within(b)).stopReason).toEqual({ kind: "interrupted", initiatedBy: "user" });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("immediately restarting during cancelled compression allows the new turn to compress", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "model-stop-compression-restart-")), entered = deferred<AbortSignal | undefined>(), late = deferred<CompletionResult>();
  try {
    const { cv } = seed(dataDir, true);
    const a = handleTurn({ dataDir, repoRoot, provider: { complete: input => { entered.resolve(input.signal); return late.promise; } } }, body);
    const signalA = await within(entered.promise); stopTurn(dataDir);
    // Start synchronously after stop, before the old compression stack's finally runs.
    let compressed = 0;
    const b = handleTurn({ dataDir, repoRoot, provider: { complete: async input => {
      expect(input.signal).not.toBe(signalA); expect(input.signal?.aborted).toBe(false);
      if (input.tools[0]?.function.name !== "submitLoopSummaries") return finish("重启后完成");
      compressed++;
      return completion([{ id: "summaries", name: "submitLoopSummaries", arguments: { summary: "历史要求已处理完成。", actions: "已处理", result: "已完成" } }]);
    } } }, body);
    expect((await within(a)).stopReason).toEqual({ kind: "interrupted", initiatedBy: "user" });
    const reply = await within(b);
    expect(reply.stopReason).toEqual({ kind: "reply", text: "重启后完成" }); expect(compressed).toBeGreaterThan(0);
    expect(loadIndex(dataDir, cv, "conversationHistory").coveredSourceIds.length).toBeGreaterThan(0);
    late.resolve(finish("旧结果")); await Promise.resolve();
    expect(loadTurn(dataDir, cv, reply.turnId).stopReason).toEqual(reply.stopReason);
  } finally { late.resolve(finish()); rmSync(dataDir, { recursive: true, force: true }); }
});
