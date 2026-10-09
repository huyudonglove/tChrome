import { runtimeConfig } from "../config/runtime.ts";
const overInline = runtimeConfig.results.inlineChars + 1000;
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyLedger, loadLedger, saveLedger, paths } from "../runtime/store.ts";
import { runSessionQuery } from "./session-query.ts";

let dataDir = "";

const row = (over: Record<string, unknown>) => ({
  batchId: "batch_01",
  name: "local_run",
  arguments: { reason: "probe" },
  return: { stage: "complete", totalChars: 100, text: "ok" },
  ...over,
});

/** Write a toolio.jsonl row line the way store.ts persists it. */
const writeRows = (cvId: string, rows: Record<string, unknown>[]): void => {
  const ledger = loadLedger(dataDir, cvId);
  ledger.toolIO = rows as typeof ledger.toolIO;
  saveLedger(dataDir, ledger);
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "session-query-"));
  await mkdir(paths(dataDir, "cv_01").turns, { recursive: true });
  await mkdir(paths(dataDir, "cv_01").toolioDir, { recursive: true });
  await mkdir(paths(dataDir, "cv_02").turns, { recursive: true });
  await mkdir(paths(dataDir, "cv_02").toolioDir, { recursive: true });
  await writeFile(join(paths(dataDir, "cv_01").turns, "tn_01.json"), "{}", "utf8");
  const ledger = emptyLedger("cv_01");
  ledger.loops = [
    { id: "loop_01", conversationId: "cv_01", turnId: "tn_01", createdAt: "now", completedAt: "now", runtime: [{ id: "rt_01", type: "userInput", content: "inspect code" }], helm: { id: "helm_01", content: "read files", finish: "tool_calls", calls: [{ id: "call_01", name: "local_run", arguments: { command: "ls" } }, { id: "call_02", name: "local_run", arguments: { command: "du" } }] } },
    { id: "loop_02", conversationId: "cv_01", turnId: "tn_02", createdAt: "now", completedAt: "now", runtime: [{ id: "rt_02", type: "callsResult", content: [{ callId: "call_03", name: "local_fs_read", result: "read evidence", keepInCalls: true }] }], helm: { id: "helm_02", content: "query source", finish: "tool_calls", calls: [{ id: "call_03", name: "local_fs_read", arguments: {} }, { id: "call_04", name: "evidence_search", arguments: { windows: [{ callId: "call_03" }] } }] } },
  ];
  ledger.tasks = [{ id: "task_01", status: "completed", title: "inspect", items: [{ id: "item_01", index: 0, text: "read", status: "done", createdAt: "now" }], createdAt: "now", updatedAt: "now" }];
  saveLedger(dataDir, ledger);
  saveLedger(dataDir, emptyLedger("cv_02"));
  writeRows("cv_01", [
    row({ callId: "call_01", turnId: "tn_01", name: "local_run", arguments: { command: "ls" } }),
    row({ callId: "call_02", turnId: "tn_01", name: "local_run", arguments: { command: "du" } }),
    row({ callId: "call_03", turnId: "tn_02", name: "local_fs_read", return: { stage: "complete", totalChars: overInline, text: "big" } }),
    row({
      callId: "call_04",
      turnId: "tn_02",
      name: "evidence_search",
      arguments: { windows: [{ callId: "call_03" }] },
      return: { stage: "complete", totalChars: 300, text: "hit" },
    }),
  ]);
  writeRows("cv_02", [row({ callId: "call_90", turnId: "tn_01", name: "finishTurn" })]);
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("summary mode aggregates calls, loops, externalized rows and return chars", () => {
  const result = runSessionQuery(dataDir, { mode: "summary" }, "cv_01") as {
    ok: boolean;
    calls: number;
    distinctTools: number;
    loops: number;
    firstLoopId: string;
    lastLoopId: string;
    externalizedCalls: number;
    totalReturnChars: number;
  };
  expect(result.ok).toBe(true);
  expect(result.calls).toBe(4);
  expect(result.distinctTools).toBe(3);
  expect(result.loops).toBe(2);
  expect(result.firstLoopId).toBe("loop_01");
  expect(result.lastLoopId).toBe("loop_02");
  expect(result.externalizedCalls).toBe(1);
  expect(result.totalReturnChars).toBe(100 + 100 + overInline + 300);
});

test("tools mode ranks by call count and reports argument value distribution", () => {
  const result = runSessionQuery(dataDir, { mode: "tools", argumentKey: "command" }, "cv_01") as {
    distinctTools: number;
    tools: { name: string; calls: number; argumentValues: { value: string; count: number }[] }[];
  };
  expect(result.distinctTools).toBe(3);
  expect(result.tools[0]!.name).toBe("local_run");
  expect(result.tools[0]!.calls).toBe(2);
  expect(result.tools[0]!.argumentValues.map((item) => item.value).sort()).toEqual(["du", "ls"]);
  expect(result.tools.some((tool) => tool.name === "local_fs_read")).toBe(true);
});

test("loop, runtime, helm and task IDs retrieve complete current-conversation records", () => {
  const loops = runSessionQuery(dataDir, { mode: "loops", loopId: "loop_02" }, "cv_01");
  expect(loops).toMatchObject({ matched: 1, items: [{ id: "loop_02", runtime: [{ id: "rt_02" }], helm: { id: "helm_02" } }] });
  expect(runSessionQuery(dataDir, { mode: "runtime", runtimeId: "rt_01" }, "cv_01")).toMatchObject({ matched: 1, items: [{ id: "rt_01", loopId: "loop_01", content: "inspect code" }] });
  expect(runSessionQuery(dataDir, { mode: "helm", helmId: "helm_02" }, "cv_01")).toMatchObject({ matched: 1, items: [{ id: "helm_02", loopId: "loop_02", content: "query source" }] });
  expect(runSessionQuery(dataDir, { mode: "tasks", taskId: "task_01" }, "cv_01")).toMatchObject({ matched: 1, items: [{ id: "task_01", status: "completed", items: [{ id: "item_01", status: "done" }] }] });
  expect(runSessionQuery(dataDir, { mode: "tasks", taskId: "task_01" }, "cv_02")).toMatchObject({ status: "not_found", matched: 0, items: [] });
  expect(runSessionQuery(dataDir, { mode: "loops", keyword: "not-present" }, "cv_01")).toMatchObject({ status: "not_found", items: [] });
  for (const mode of ["turns", "notes", "workspace"]) expect(runSessionQuery(dataDir, { mode }, "cv_01")).toMatchObject({ ok: false, faultCode: "invalid_mode" });
});

test("calls mode filters by loop, tool and keyword", () => {
  const byTurn = runSessionQuery(dataDir, { mode: "calls", loopId: "loop_01" }, "cv_01") as {
    matched: number;
    items: { callId: string }[];
  };
  expect(byTurn.matched).toBe(2);

  const byKeyword = runSessionQuery(dataDir, { mode: "calls", keyword: "call_04" }, "cv_01") as {
    matched: number;
    items: { callId: string; name: string }[];
  };
  expect(byKeyword.matched).toBe(1);
  expect(byKeyword.items[0]!.name).toBe("evidence_search");

  const noHit = runSessionQuery(dataDir, { mode: "calls", keyword: "not-present-anywhere" }, "cv_01") as {
    ok: boolean;
    matched: number;
    items: unknown[];
  };
  expect(noHit.ok).toBe(true);
  expect(noHit.matched).toBe(0);
  expect(noHit.items).toHaveLength(0);
});

test("externalized mode lists oversized returns largest first", () => {
  const result = runSessionQuery(dataDir, { mode: "externalized" }, "cv_01") as {
    externalizedCalls: number;
    items: { callId: string; name: string; totalChars: number }[];
    hint: string;
  };
  expect(result.externalizedCalls).toBe(1);
  expect(result.items[0]).toMatchObject({ callId: "call_03", name: "local_fs_read", totalChars: overInline });
  expect(result.hint).toContain("evidence_search");
});

test("conversations mode lists every conversation with loop counts", () => {
  const result = runSessionQuery(dataDir, { mode: "conversations" }) as {
    ok: boolean;
    conversations: { conversationId: string; loops: number; bytes: number }[];
  };
  expect(result.ok).toBe(true);
  const ids = result.conversations.map((item) => item.conversationId).sort();
  expect(ids).toEqual(["cv_01", "cv_02"]);
  const cv01 = result.conversations.find((item) => item.conversationId === "cv_01")!;
  expect(cv01.loops).toBe(2);
  expect(cv01.bytes).toBeGreaterThan(0);
});

test("unknown, missing and invalid mode fail with actionable fault codes", () => {
  const unknown = runSessionQuery(dataDir, { mode: "summary", conversationId: "cv_99" }, "cv_01") as {
    ok: boolean;
    faultCode: string;
    conversations: string[];
  };
  expect(unknown.ok).toBe(false);
  expect(unknown.faultCode).toBe("unknown_conversation");
  expect(unknown.conversations).toContain("cv_01");

  const missing = runSessionQuery(dataDir, { mode: "summary" }) as { ok: boolean; faultCode: string };
  expect(missing.ok).toBe(false);
  expect(missing.faultCode).toBe("missing_conversation");

  const invalid = runSessionQuery(dataDir, { mode: "nope" }, "cv_01") as { ok: boolean; faultCode: string };
  expect(invalid.ok).toBe(false);
  expect(invalid.faultCode).toBe("invalid_mode");
});
