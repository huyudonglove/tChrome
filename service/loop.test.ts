import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTurn } from "./runtime/loop.ts";
import { createServer } from "./server.ts";
import { createProvider } from "./provider/uuapi.ts";
import { createToolBridge } from "./runtime/bridge.ts";
import { loadEvents, loadLedger, loadMemory, loadSession, loadTurn } from "./runtime/store.ts";
import { maybeCompress } from "./runtime/compress.ts";
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
  const events = loadEvents(dir, "cv_01");
  expect(events.map((row) => row.kind)).toEqual([
    "session",
    "normalize",
    "assemble",
    "provider-request",
    "provider-response",
    "tool",
    "turn-output",
  ]);
  expect(events[1]?.data.userInput).toBe("你好");
  expect(events.at(-1)?.data.output).toEqual({ kind: "reply", text: "你好" });
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
    host: { execute: async () => ({ ok: false }) },
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

test("有浏览器桥时 currentPage 由 see_page 填", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-page-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      toolCalls: [{ id: "call_01", name: "finishTurn", arguments: { reason: "答完", affectsPage: false } }],
    }),
  ]);
  const host = {
    execute: async () => ({
      ok: true,
      tab: 12,
      url: "https://item.jd.com/100012345678.html",
      title: "罗技 MX Master 3S 无线鼠标",
      description: "当前页面信息",
    }),
  };
  const reply = await handleTurn({ dataDir: dir, repoRoot, provider, host }, { userInput: "你好", submittedAt: "2026-09-06T00:00:00.000Z" });
  const turn = loadTurn(dir, "cv_01", reply.turnId);
  expect(turn.assembled.currentPage).toEqual({
    description: "当前页面信息",
    tab: 12,
    url: "https://item.jd.com/100012345678.html",
    title: "罗技 MX Master 3S 无线鼠标",
  });
  rmSync(dir, { recursive: true, force: true });
});

test("web_search 走服务端执行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-search-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      content: "observation\n要搜价\nreason\n搜官网\naction\nweb_search",
      toolCalls: [{ id: "call_01", name: "web_search", arguments: { reason: "搜价", affectsPage: false, query: "罗技 MX Master 3S" } }],
    }),
    ok({
      finish: "tool_calls",
      content: "observation\n搜到了\nreason\n收口\naction\n官价 699",
      toolCalls: [{ id: "call_02", name: "finishTurn", arguments: { reason: "有价了", affectsPage: false } }],
    }),
  ]);
  const host = {
    execute: async (name: string) => {
      if (name === "see_page") return { ok: true, tab: 12, url: "https://item.jd.com/x", title: "罗技", description: "当前页面信息" };
      return { ok: false, error: name };
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("duckduckgo")) {
      return new Response('<a href="https://html.duckduckgo.com/html/?uddg=https%3A%2F%2Fwww.logitech.com">hit</a>', { status: 200 });
    }
    return originalFetch(input);
  }) as typeof fetch;
  try {
    const reply = await handleTurn({ dataDir: dir, repoRoot, provider, host }, { userInput: "这鼠标官网多少钱", submittedAt: "2026-09-06T00:00:00.000Z" });
    expect(reply.output).toEqual({ kind: "reply", text: "官价 699" });
    const turn = loadTurn(dir, "cv_01", reply.turnId);
    expect(turn.assembled.toolIds).toContain("see_page");
    expect(turn.assembled.toolIds).toContain("web_search");
    expect(turn.assembled.currentPage?.tab).toBe(12);
    const ledger = loadLedger(dir, "cv_01");
    const search = ledger.toolIO.find((row) => row.name === "web_search");
    expect(search?.return.text).toContain("logitech.com");
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /tool-request 和 POST /tool-result 对上", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-bridge-"));
  const bridge = createToolBridge(2000);
  const server = createServer({ dataDir: dir, repoRoot, provider: mock([]), bridge });
  const empty = await server.fetch(new Request("http://127.0.0.1:18788/tool-request"));
  expect(await empty.json()).toEqual({ request: null });
  const pending = bridge.execute("see_page", {});
  const listed = await server.fetch(new Request("http://127.0.0.1:18788/tool-request"));
  const body = await listed.json() as { request: { id: string; name: string } };
  expect(body.request.name).toBe("see_page");
  const posted = await server.fetch(new Request("http://127.0.0.1:18788/tool-result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: body.request.id, result: { ok: true, tab: 3, url: "https://example.com", title: "ex" } }),
  }));
  expect(await posted.json()).toEqual({ ok: true });
  expect(await pending).toEqual({ ok: true, tab: 3, url: "https://example.com", title: "ex" });
  rmSync(dir, { recursive: true, force: true });
});

test("GET /session 还原消息，切会话改 session.json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-session-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      toolCalls: [{ id: "call_01", name: "finishTurn", arguments: { reason: "答完", affectsPage: false } }],
    }),
  ]);
  const server = createServer({ dataDir: dir, repoRoot, provider, host: { execute: async () => ({ ok: false }) } });
  await server.fetch(new Request("http://127.0.0.1:18788/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userInput: "你好", submittedAt: "2026-09-06T00:00:00.000Z" }),
  }));
  const session = await (await server.fetch(new Request("http://127.0.0.1:18788/session"))).json();
  expect(session.conversationId).toBe("cv_01");
  expect(session.messages).toEqual([
    { turnId: "tn_01", role: "user", text: "你好" },
    { turnId: "tn_01", role: "assistant", text: "你好" },
  ]);
  const created = await (await server.fetch(new Request("http://127.0.0.1:18788/conversations/new", { method: "POST" }))).json();
  expect(created.conversationId).toBe("cv_02");
  expect(created.messages).toEqual([]);
  expect(JSON.parse(readFileSync(join(dir, "session.json"), "utf8")).conversationId).toBe("cv_02");
  const opened = await (await server.fetch(new Request("http://127.0.0.1:18788/conversations/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId: "cv_01" }),
  }))).json();
  expect(opened.conversationId).toBe("cv_01");
  expect(opened.messages[0].text).toBe("你好");
  const listed = await (await server.fetch(new Request("http://127.0.0.1:18788/conversations"))).json();
  expect(listed.items.map((item: { conversationId: string }) => item.conversationId).sort()).toEqual(["cv_01", "cv_02"]);
  rmSync(dir, { recursive: true, force: true });
});

test("到门槛时压缩 toolIO 和 turn/conversation 记忆", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-compress-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      content: "observation\n记下\nreason\n写记忆并收口\naction\n记下了",
      toolCalls: [
        {
          id: "call_01",
          name: "memory.write",
          arguments: {
            reason: "记下",
            affectsPage: false,
            turnMemory: ["本轮用户要查鼠标价"],
            conversationMemory: ["用户在核对罗技 MX Master 3S"],
            projectMemory: ["项目偏好：查官网价"],
          },
        },
        { id: "call_02", name: "finishTurn", arguments: { reason: "答完", affectsPage: false } },
      ],
    }),
  ]);
  await handleTurn({ dataDir: dir, repoRoot, provider, host: { execute: async () => ({ ok: false }) } }, {
    userInput: "查价",
    submittedAt: "2026-09-06T00:00:00.000Z",
  });
  const ledger = loadLedger(dir, "cv_01");
  expect(ledger.memoryIds.turn).toHaveLength(1);
  expect(loadMemory(dir, "cv_01", ledger.memoryIds.turn[0]!).compressed).toBe(false);
  expect(loadMemory(dir, "cv_01", ledger.memoryIds.project[0]!).compressed).toBe(false);
  ledger.compressAt = 1;
  maybeCompress({ dataDir: dir, ledger, windowChars: 200000 });
  expect(loadMemory(dir, "cv_01", ledger.memoryIds.turn[0]!).compressed).toBe(true);
  expect(loadMemory(dir, "cv_01", ledger.memoryIds.conversation[0]!).compressed).toBe(true);
  expect(loadMemory(dir, "cv_01", ledger.memoryIds.project[0]!).compressed).toBe(false);
  expect(loadMemory(dir, "cv_01", ledger.memoryIds.turn[0]!).text).toBe("本轮用户要查鼠标价");
  const events = loadEvents(dir, "cv_01");
  expect(events.some((row) => row.kind === "compress")).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});
