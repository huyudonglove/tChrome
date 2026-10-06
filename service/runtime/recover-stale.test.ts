import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyLedger,
  loadLedger,
  loadTurn,
  recoverStaleRuns,
  saveLedger,
  saveTurn,
} from "./store.ts";
import type { Turn } from "../types.ts";

const tempDataDir = () => mkdtempSync(join(tmpdir(), "tchrome-stale-"));

test("recoverStaleRuns 把被杀进程留下的 running 会话复位并收尾该轮", () => {
  const dataDir = tempDataDir();
  const cvId = "cv_01";
  const ledger = emptyLedger(cvId);
  ledger.status = "running";
  ledger.active = { turnId: "tn_01" };
  saveLedger(dataDir, ledger);
  const at = new Date().toISOString();
  saveTurn(dataDir, {
    turnId: "tn_01",
    conversationId: cvId,
    status: "inferring",
    createdAt: at,
    completedAt: null,
    input: { id: "input_01", text: "继续", submittedAt: at },
    assembled: {},
    actions: [],
    stopReason: null,
    usage: { modelRequests: 0, toolCalls: 0 },
  } as unknown as Turn);

  const recovered = recoverStaleRuns(dataDir);

  expect(recovered).toEqual([cvId]);
  expect(loadLedger(dataDir, cvId).status).toBe("paused");
  expect(loadLedger(dataDir, cvId).active).toBeNull();
  expect(loadTurn(dataDir, cvId, "tn_01").status).toBe("failed");
});

test("recoverStaleRuns 不碰空闲会话", () => {
  const dataDir = tempDataDir();
  saveLedger(dataDir, emptyLedger("cv_02"));
  expect(recoverStaleRuns(dataDir)).toEqual([]);
  expect(loadLedger(dataDir, "cv_02").status).toBe("idle");
});
