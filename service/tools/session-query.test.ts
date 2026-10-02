import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../runtime/store.ts";
import { runSessionQuery } from "./session-query.ts";

let dataDir = "";

const row = (over: Record<string, unknown>) => ({
  batchId: "batch_01",
  name: "local.run",
  arguments: { reason: "probe" },
  return: { stage: "complete", totalChars: 100, text: "ok" },
  ...over,
});

/** Write a toolio.jsonl row line the way store.ts persists it. */
const writeRows = (cvId: string, rows: Record<string, unknown>[]): void => {
  const target = paths(dataDir, cvId).toolio;
  writeFileSync(target, rows.map((entry) => JSON.stringify({ k: "row", row: entry })).join("\n") + "\n", "utf8");
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "session-query-"));
  await mkdir(paths(dataDir, "cv_01").turns, { recursive: true });
  await mkdir(paths(dataDir, "cv_01").toolioDir, { recursive: true });
  await mkdir(paths(dataDir, "cv_02").turns, { recursive: true });
  await mkdir(paths(dataDir, "cv_02").toolioDir, { recursive: true });
  await writeFile(join(paths(dataDir, "cv_01").turns, "tn_01.json"), "{}", "utf8");
  writeRows("cv_01", [
    row({ callId: "call_01", turnId: "tn_01", name: "local.run", arguments: { command: "ls" } }),
    row({ callId: "call_02", turnId: "tn_01", name: "local.run", arguments: { command: "du" } }),
    row({ callId: "call_03", turnId: "tn_02", name: "local.fs_read", return: { stage: "complete", totalChars: 7000, text: "big" } }),
    row({
      callId: "call_04",
      turnId: "tn_02",
      name: "evidence.search",
      arguments: { windows: [{ callId: "call_03" }] },
      return: { stage: "complete", totalChars: 300, text: "hit" },
    }),
  ]);
  writeRows("cv_02", [row({ callId: "call_90", turnId: "tn_01", name: "finishTurn" })]);
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("summary mode aggregates calls, turns, externalized rows and return chars", () => {
  const result = runSessionQuery(dataDir, { mode: "summary" }, "cv_01") as {
    ok: boolean;
    calls: number;
    distinctTools: number;
    turns: number;
    firstTurnId: string;
    lastTurnId: string;
    externalizedCalls: number;
    totalReturnChars: number;
  };
  expect(result.ok).toBe(true);
  expect(result.calls).toBe(4);
  expect(result.distinctTools).toBe(3);
  expect(result.turns).toBe(2);
  expect(result.firstTurnId).toBe("tn_01");
  expect(result.lastTurnId).toBe("tn_02");
  expect(result.externalizedCalls).toBe(1);
  expect(result.totalReturnChars).toBe(100 + 100 + 7000 + 300);
});

test("tools mode ranks by call count and reports argument value distribution", () => {
  const result = runSessionQuery(dataDir, { mode: "tools", argumentKey: "command" }, "cv_01") as {
    distinctTools: number;
    tools: { name: string; calls: number; argumentValues: { value: string; count: number }[] }[];
  };
  expect(result.distinctTools).toBe(3);
  expect(result.tools[0]!.name).toBe("local.run");
  expect(result.tools[0]!.calls).toBe(2);
  expect(result.tools[0]!.argumentValues.map((item) => item.value).sort()).toEqual(["du", "ls"]);
  expect(result.tools.some((tool) => tool.name === "local.fs_read")).toBe(true);
});

test("turns mode groups by turn and orders by call volume", () => {
  const result = runSessionQuery(dataDir, { mode: "turns" }, "cv_01") as {
    totalTurns: number;
    turns: { turnId: string; calls: number; distinctTools: number; externalized: number }[];
  };
  expect(result.totalTurns).toBe(2);
  expect(result.turns[0]).toMatchObject({ turnId: "tn_02", calls: 2, distinctTools: 2, externalized: 1 });
  expect(result.turns[1]).toMatchObject({ turnId: "tn_01", calls: 2, distinctTools: 1, externalized: 0 });
});

test("calls mode filters by turn, tool and keyword", () => {
  const byTurn = runSessionQuery(dataDir, { mode: "calls", turnId: "tn_01" }, "cv_01") as {
    matched: number;
    items: { callId: string }[];
  };
  expect(byTurn.matched).toBe(2);

  const byKeyword = runSessionQuery(dataDir, { mode: "calls", keyword: "call_04" }, "cv_01") as {
    matched: number;
    items: { callId: string; name: string }[];
  };
  expect(byKeyword.matched).toBe(1);
  expect(byKeyword.items[0]!.name).toBe("evidence.search");

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
  expect(result.items[0]).toMatchObject({ callId: "call_03", name: "local.fs_read", totalChars: 7000 });
  expect(result.hint).toContain("evidence.search");
});

test("conversations mode lists every conversation with turn counts", () => {
  const result = runSessionQuery(dataDir, { mode: "conversations" }) as {
    ok: boolean;
    conversations: { conversationId: string; turns: number; bytes: number }[];
  };
  expect(result.ok).toBe(true);
  const ids = result.conversations.map((item) => item.conversationId).sort();
  expect(ids).toEqual(["cv_01", "cv_02"]);
  const cv01 = result.conversations.find((item) => item.conversationId === "cv_01")!;
  expect(cv01.turns).toBe(1);
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
