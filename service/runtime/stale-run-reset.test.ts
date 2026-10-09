import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTurn } from "./loop.ts";
import { beginExecution, hasActiveExecution } from "./execution.ts";
import {
  emptyLedger,
  loadLedger,
  loadTurn,
  primeActiveTask,
  saveLedger,
  saveTurn,
  stopTurn,
} from "./store.ts";
import type { Provider, Turn } from "../types.ts";
import { allocateRecordId } from "./ids.ts";

const repoRoot = join(import.meta.dir, "..", "..");
const at = "2026-09-06T00:00:00.000Z";

const tempDataDir = () => mkdtempSync(join(tmpdir(), "tchrome-stale-run-"));

/** 一份「账本说 running、进程内却没有活执行」的脏数据：模拟上一进程被硬杀留下的状态。 */
const staleRunning = (dir: string, cvId: string, turnId: string): void => {
  primeActiveTask(dir);
  // 先占用该会话的 turn 计数器，让新轮次拿到下一个编号，而不是复用被复位轮的 tn_01。
  const allocated = allocateRecordId(dir, cvId, "turn");
  if (allocated !== turnId) throw new Error(`夹具预期 ${turnId}，实际分配 ${allocated}`);
  const ledger = emptyLedger(cvId);
  ledger.status = "running";
  ledger.active = { turnId };
  ledger.turnIds = [turnId];
  saveLedger(dir, ledger);
  saveTurn(dir, {
    turnId,
    conversationId: cvId,
    status: "inferring",
    createdAt: at,
    completedAt: null,
    input: { id: "input_fixture", text: "上一轮", submittedAt: at },
    assembled: {
      baseToolsIds: [],
      toolIds: [],
      conversationMemoryIds: [],
      projectMemoryIds: [],
      mcpIds: [],
      currentTabs: { ok: true, windows: [] },
      currentPage: null,
      observations: [],
        },
    actions: [],
    stopReason: null,
    usage: { modelRequests: 0, toolCalls: 0 },
  } as unknown as Turn);
};

test("账本残留 running 但本进程无该会话的活执行时，新 /turn 自动复位而不是回 busy", async () => {
  const dir = tempDataDir();
  try {
    staleRunning(dir, "cv_01", "tn_01");
    const provider: Provider = {
      complete: async () => ({
        finish: "tool_calls",
        content: "",
        toolCalls: [{ id: "f1", name: "finishTurn", arguments: { text: "已复位并继续" } }],
        attempts: 1,
        parseOk: true,
        schemaOk: true,
        faultCode: null,
        missing: [],
      }),
    };
    const host = { execute: async () => ({ ok: true, tabId: 1, url: "https://example.com", title: "t" }) };

    const reply = await handleTurn(
      { dataDir: dir, repoRoot, provider, host },
      { userInput: "继续", submittedAt: at },
    );

    expect(reply.stopReason).toEqual({ kind: "reply", text: "已复位并继续" });
    const stale = loadTurn(dir, "cv_01", "tn_01");
    expect(stale.status).toBe("failed");
    expect(stale.stopReason).toMatchObject({ kind: "interrupted", initiatedBy: "service" });
    expect(loadLedger(dir, "cv_01").status).toBe("idle");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopTurn 按发起者标记停止原因：脚本停止记 service", () => {
  const dir = tempDataDir();
  try {
    staleRunning(dir, "cv_01", "tn_01");

    stopTurn(dir, "cv_01", "service");

    expect(loadTurn(dir, "cv_01", "tn_01").stopReason).toMatchObject({
      kind: "interrupted",
      initiatedBy: "service",
    });
    expect(loadLedger(dir, "cv_01").status).toBe("paused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hasActiveExecution 只认本进程登记在跑的执行", () => {
  const dir = tempDataDir();
  try {
    expect(hasActiveExecution(dir, "cv_01")).toBe(false);
    const provider: Provider = {
      complete: async () => ({
        finish: "tool_calls",
        content: "",
        toolCalls: [],
        attempts: 1,
        parseOk: true,
        schemaOk: true,
        faultCode: null,
        missing: [],
      }),
    };

    const execution = beginExecution(dir, "cv_01", "tn_01", provider);
    expect(hasActiveExecution(dir, "cv_01")).toBe(true);

    execution.finish();
    expect(hasActiveExecution(dir, "cv_01")).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
