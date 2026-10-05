import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTurn, runTurnWithContinuation } from "./loop.ts";
import { emptyLedger, ensureSession, loadLedger, loadTurn, primeActiveTask, saveLedger } from "./store.ts";
import { projectConversationList, projectSessionView } from "../presentation/session-view.ts";
import { continuationInputText } from "../../shared/continuation.ts";
import { runtimeConfig } from "../config/runtime.ts";
import type { CompletionResult, Provider, Turn } from "../types.ts";

const repoRoot = join(import.meta.dir, "../..");

const result = (partial: Partial<CompletionResult>): CompletionResult => ({
  finish: "tool_calls", content: "", toolCalls: [], attempts: 1, parseOk: true, schemaOk: true,
  faultCode: null, missing: [], ...partial,
});
// notes_write is the cheapest core tool that puts text into the window, so one call is enough
// to push a turn's own injected content past a tiny rotation threshold.
const note = (id: string): CompletionResult => result({
  toolCalls: [{ id, name: "notes_write", arguments: { reason: "记录", key: id, value: "阶段结论".repeat(60) } }],
});
const finished: CompletionResult = result({
  toolCalls: [{ id: "finish", name: "finishTurn", arguments: { reason: "完成", text: "已收尾" } }],
});
const summarized: CompletionResult = result({
  toolCalls: [{ id: "submit", name: "submitTurnSummaries", arguments: { summary: "本轮被强制闭合等待续接。", actions: "本轮被强制闭合", result: "该轮已闭合，等待续接" } }],
});

// Compression runs on the same provider, so the main script must only see ordinary turn calls.
const providerOf = (main: (calls: number) => CompletionResult) => {
  let calls = 0;
  const provider: Provider = {
    complete: async (input) => {
      const names = input.tools.map((tool) => tool.function.name);
      if (names.length === 1 && names[0] === "submitTurnSummaries") return summarized;
      calls += 1;
      return main(calls);
    },
  };
  return { provider, calls: () => calls };
};

const rotateAt = (dataDir: string) => {
  primeActiveTask(dataDir);
  const session = ensureSession(dataDir);
  const ledger = loadLedger(dataDir, session.conversationId);
  ledger.turnRotateAt = 1;
  saveLedger(dataDir, ledger);
  return session.conversationId;
};

const makeTurn = (conversationId: string, turnId: string, text: string, stopReason: Turn["stopReason"]): Turn => ({
  conversationId, turnId, status: "completed", createdAt: "2026-10-03", completedAt: "2026-10-03",
  input: { id: `input_${turnId}`, text, submittedAt: "2026-10-03" },
  assembled: { baseToolsIds: [], toolIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], currentTabs: { ok: true, windows: [] }, currentPage: null, observations: [], workspace: [] },
  stopReason,
});

test("a turn past the rotation threshold closes as settled and frees the ledger for a continuation", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-rotate-"));
  try {
    const conversationId = rotateAt(dataDir);
    const { provider } = providerOf((calls) => note(`note_${calls}`));
    const reply = await handleTurn({ dataDir, repoRoot, provider }, { userInput: "长任务", submittedAt: "2026-10-03" });
    expect(reply.stopReason.kind).toBe("rotated");
    // The close-prep checkpoint defers one send to ask for an observation, so the turn runs
    // twice before closing rather than cutting the model off on its first return.
    expect(reply.stopReason).toMatchObject({ kind: "rotated" });
    const turn = loadTurn(dataDir, conversationId, reply.turnId);
    expect(turn.status).toBe("completed");
    expect(turn.completedAt).not.toBeNull();
    const ledger = loadLedger(dataDir, conversationId);
    expect(ledger.active).toBeNull();
    expect(ledger.status).toBe("idle");
    expect(ledger.pendingAsk).toBeNull();
    expect(ledger.liveTools).toEqual([]);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("past the rotation cap the turn keeps running on the normal path instead of being cut off", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-rotate-cap-"));
  try {
    const conversationId = rotateAt(dataDir);
    const { provider, calls } = providerOf((count) => (count === 1 ? note("note_1") : finished));
    const reply = await handleTurn({ dataDir, repoRoot, provider },
      { userInput: "长任务", submittedAt: "2026-10-03", rotations: runtimeConfig.context.maxTurnRotations });
    expect(reply.stopReason).toEqual({ kind: "reply", text: "已收尾" });
    expect(calls()).toBe(2);
    expect(loadLedger(dataDir, conversationId).active).toBeNull();
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("one submission keeps rotating into continuation turns until the cap returns a terminal reply", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-rotate-chain-"));
  try {
    const conversationId = rotateAt(dataDir);
    // Each turn spends two sends (checkpoint nudge, then the send that precedes the close);
    // the turn opened at the cap runs on and answers instead of rotating again.
    const { provider, calls } = providerOf((count) => (count <= 2 * runtimeConfig.context.maxTurnRotations ? note(`note_${count}`) : finished));
    const reply = await runTurnWithContinuation({ dataDir, repoRoot, provider }, { userInput: "长任务", submittedAt: "2026-10-03" });
    expect(reply.stopReason).toEqual({ kind: "reply", text: "已收尾" });
    const ledger = loadLedger(dataDir, conversationId);
    expect(ledger.turnIds).toHaveLength(runtimeConfig.context.maxTurnRotations + 1);
    const turns = ledger.turnIds.map((turnId) => loadTurn(dataDir, conversationId, turnId));
    expect(turns.slice(0, -1).every((turn) => turn.stopReason?.kind === "rotated")).toBe(true);
    expect(turns[0]!.input.text).toBe("长任务");
    expect(turns.slice(1).every((turn) => turn.input.text === continuationInputText("长任务"))).toBe(true);
    expect(calls()).toBe(2 * runtimeConfig.context.maxTurnRotations + 1);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("a continuation turn renders no user bubble and the list preview keeps the original input", () => {
  const ledger = emptyLedger("cv_01");
  const rotated = { kind: "rotated", turnChars: 210000, turnDeltaChars: 205000 } as const;
  const view = projectSessionView({
    ledger,
    events: [],
    turns: [makeTurn("cv_01", "tn_01", "原始要求", { kind: "reply", text: "上一轮结论" }),
      makeTurn("cv_01", "tn_02", continuationInputText("原始要求"), rotated)],
  });
  expect(view.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual(["原始要求"]);
  expect(view.messages.some((message) => message.role === "assistant" && /闭合/.test(message.text))).toBe(true);
  expect(projectConversationList([{ ledger, lastTurn: makeTurn("cv_01", "tn_02", continuationInputText("原始要求"), rotated) }])[0]!.preview)
    .toBe("原始要求");
});
