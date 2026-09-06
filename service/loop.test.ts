import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTurn } from "./runtime/loop.ts";
import { createServer } from "./server.ts";
import { createProvider } from "./provider/uuapi.ts";
import { loadLedger, loadSession, loadTurn } from "./runtime/store.ts";
import type { CompletionResult, Provider } from "./types.ts";

const repoRoot = join(import.meta.dir, "..");

const ok = (partial: Partial<CompletionResult> & Pick<CompletionResult, "finish">): CompletionResult => ({
  content: "observation\n已收到\nreason\n收口\naction\n你好",
  toolCalls: [],
  attempts: 1,
  parseOk: true,
  schemaOk: true,
  faultCode: null,
  missing: [],
  ...partial,
});

const mock = (results: CompletionResult[]): Provider => {
  let i = 0;
  return {
    complete: async () => {
      const next = results[i] ?? results.at(-1);
      i += 1;
      if (!next) throw new Error("no mock");
      return next;
    },
  };
};

test("GET /health", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-health-"));
  const server = createServer({ dataDir: dir, repoRoot, provider: mock([]) });
  const response = await server.fetch(new Request("http://127.0.0.1:18788/health"));
  expect(await response.json()).toEqual({ ok: true });
  rmSync(dir, { recursive: true, force: true });
});

test("缺钥分得出网失败", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-key-"));
  const provider = createProvider({ apiKey: "" });
  const reply = await handleTurn({ dataDir: dir, repoRoot, provider }, { userInput: "hi", submittedAt: "2026-09-06T00:00:00.000Z" });
  expect(reply.output).toEqual({ kind: "error", faultCode: "provider_key_missing" });
  expect(loadSession(dir)?.conversationId).toStartWith("cv_");
  rmSync(dir, { recursive: true, force: true });
});

test("finishTurn 收口回复", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-finish-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      toolCalls: [{ id: "call_01", name: "finishTurn", arguments: { reason: "答完", affectsPage: false } }],
    }),
  ]);
  const reply = await handleTurn({ dataDir: dir, repoRoot, provider }, { userInput: "你好", submittedAt: "2026-09-06T00:00:00.000Z" });
  expect(reply.output).toEqual({ kind: "reply", text: "你好" });
  const session = loadSession(dir);
  expect(session?.conversationId).toBe("cv_01");
  const ledger = loadLedger(dir, "cv_01");
  expect(ledger.status).toBe("idle");
  expect(ledger.userInputHistory).toEqual([]);
  const turn = loadTurn(dir, "cv_01", reply.turnId);
  expect(turn.assembled.currentPage).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test("askUser 冻在追问", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-ask-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      content: "observation\n缺尺码\nreason\n问用户\naction\n要哪个尺码",
      toolCalls: [{ id: "call_02", name: "askUser", arguments: { reason: "缺尺码", affectsPage: false, choice: ["S", "M"] } }],
    }),
  ]);
  const reply = await handleTurn({ dataDir: dir, repoRoot, provider }, { userInput: "买这件", submittedAt: "2026-09-06T00:00:00.000Z" });
  expect(reply.output.kind).toBe("ask");
  if (reply.output.kind === "ask") expect(reply.output.question).toContain("要哪个尺码");
  const ledger = loadLedger(dir, "cv_01");
  expect(ledger.status).toBe("waiting_human");
  rmSync(dir, { recursive: true, force: true });
});

test("下一句开新 Turn 并追加 userInputHistory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-hist-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      toolCalls: [{ id: "call_01", name: "finishTurn", arguments: { reason: "先回", affectsPage: false } }],
    }),
    ok({
      finish: "tool_calls",
      content: "observation\n第二句\nreason\n收口\naction\n第二回",
      toolCalls: [{ id: "call_02", name: "finishTurn", arguments: { reason: "再回", affectsPage: false } }],
    }),
  ]);
  const deps = { dataDir: dir, repoRoot, provider };
  await handleTurn(deps, { userInput: "第一句", submittedAt: "2026-09-06T00:00:00.000Z" });
  const second = await handleTurn(deps, { userInput: "第二句", submittedAt: "2026-09-06T00:00:01.000Z" });
  expect(second.output).toEqual({ kind: "reply", text: "第二回" });
  const ledger = loadLedger(dir, "cv_01");
  expect(ledger.userInputHistory).toEqual(["第一句"]);
  expect(ledger.turnIds).toEqual(["tn_01", "tn_02"]);
  rmSync(dir, { recursive: true, force: true });
});

test("POST /turn 走完 mock 收口", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-http-"));
  const server = createServer({
    dataDir: dir,
    repoRoot,
    provider: mock([
      ok({
        finish: "tool_calls",
        toolCalls: [{ id: "call_01", name: "finishTurn", arguments: { reason: "答完", affectsPage: false } }],
      }),
    ]),
  });
  const response = await server.fetch(
    new Request("http://127.0.0.1:18788/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userInput: "你好", submittedAt: "2026-09-06T00:00:00.000Z" }),
    }),
  );
  const body = await response.json();
  expect(body.output).toEqual({ kind: "reply", text: "你好" });
  expect(JSON.parse(readFileSync(join(dir, "session.json"), "utf8")).conversationId).toBe("cv_01");
  rmSync(dir, { recursive: true, force: true });
});
