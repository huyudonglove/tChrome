import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTurn } from "./runtime/loop.ts";
import { createServer } from "./server.ts";
import { createProvider } from "./provider/uuapi.ts";
import { createToolBridge } from "./runtime/bridge.ts";
import { stopTurn, emptyLedger, loadEvents, loadLedger, loadMemory, loadProviderLog, loadSession, loadTurn, saveLedger, saveTurn, sessionView } from "./runtime/store.ts";
import { loadCatalog } from "./prompt/catalog.ts";
import { systemText, userText } from "./context/window.ts";
import { maybeCompress } from "./runtime/compress.ts";
import type { CompletionResult, Provider } from "./types.ts";

const repoRoot = join(import.meta.dir, "..");

const ok = (partial: Partial<CompletionResult> & Pick<CompletionResult, "finish">): CompletionResult => ({
  content: "seen\n已收到\nreason\n收口\naction\n你好",
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

test("窗口按 catalog 模板插值", async () => {
  const catalog = loadCatalog(repoRoot);
  expect(catalog.assemble.baseToolsIds).toContain("notes.write");
  expect(catalog.assemble.baseToolsIds).toContain("notes.delete");
  expect(catalog.userTemplate).toContain("{{#notes}}");
  expect(catalog.userTemplate).toContain("{{#goal}}");
  expect(catalog.userTemplate).toContain("{{#goalHistory}}");
  expect(catalog.assemble.coreToolIds).toContain("page.get_summary");
  expect(catalog.systemTemplate).toContain("{{#baseTools}}");
  expect(catalog.userTemplate).not.toContain("{{#baseTools}}");
  expect(catalog.userTemplate).toContain("{{#tools}}");
  expect(catalog.userTemplate).not.toContain("{{#sop}}");
  expect(catalog.userTemplate).toContain("{{#currentTab}}");
  expect(catalog.userTemplate).toContain("{{#currentPage}}");
  expect(catalog.userTemplate).not.toContain("{{#参考}}");
  expect(catalog.userTemplate).not.toContain("{{#currentEnvironment}}");
  expect(catalog.systemTemplate).not.toContain("{{#skill}}");
  expect(catalog.systemTemplate).not.toContain("{{#sop}}");
  const system = systemText(catalog);
  expect(system).toContain("#identity");
  expect(system).toContain("tChrome");
  expect(system).toContain("参考材料");
  expect(system).toContain("摘要可能丢失细节，不代表完整原文");
  expect(system).toContain("目标变化时非空旧目标自动加入 #goalHistory");
  expect(system).not.toMatch(/ledger\.|windowChars|compressAt/);
  expect(system).not.toContain("#sop");
  expect(system).toContain("#baseTools");
  expect(system).toContain("notes.write");
  expect(system).toContain("content 的 seen");
  expect(system).not.toMatch(/baseToolsIds|coreToolIds|用途与来源|应用维护|Turn\.assembled/);
  expect(system).not.toContain("从稳到新");
  expect(system).not.toContain("常用的一撮");
  expect(system).not.toContain("这一次会话");
  expect(system).not.toContain("{{");
  expect(system).not.toContain("探索型可以由大到小");
  expect(system).not.toMatch(/^#skill$/m);
  expect(system).not.toMatch(/^#sop$/m);
  const user = userText({
    catalog,
    ledger: emptyLedger("cv_01"),
    turn: {
      turnId: "tn_01",
      conversationId: "cv_01",
      status: "inferring",
      createdAt: "2026-09-06T00:00:00.000Z",
      completedAt: null,
      input: { text: "帮我查这款鼠标官网价", submittedAt: "2026-09-06T00:00:00.000Z" },
      assembled: {

        baseToolsIds: [],
        toolIds: [],
        turnMemoryIds: [],
        conversationMemoryIds: [],
        projectMemoryIds: [],
        mcpIds: [],
        currentTab: null,
        currentPage: null,
      },
      output: { kind: "tool", name: "", callId: "" },
    },
    memories: { project: [], conversation: [], turn: [] },
    toolUsage: "web_search：搜索公开网页。",
  });
  expect(user).toContain("#notes");
  expect(user).toContain("{}");
  expect(user).toContain("#skill");
  expect(user).not.toContain("#sop");
  expect(user).toContain(catalog.skill);
  expect(system).toContain("#baseTools");
  expect(system).toContain("askUser：向用户提问");
  expect(system).toContain("finishTurn：结束本 Turn");
  expect(user).toContain("#tools");
  expect(user).toContain("web_search：搜索公开网页");
  expect(user).toContain("帮我查这款鼠标官网价");
  expect(user).not.toContain("{{");
});

test("开 Turn 写入 currentTab，不调 page 工具", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-tab-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      content: "seen\n看到标题\nreason\n收口\naction\n当前是京东",
      toolCalls: [{ id: "call_01", name: "finishTurn", arguments: { reason: "答完", affectsPage: false } }],
    }),
  ]);
  const reply = await handleTurn(
    { dataDir: dir, repoRoot, provider },
    {
      userInput: "这是什么页",
      submittedAt: "2026-09-06T00:00:00.000Z",
      currentTab: { tab: 12, url: "https://item.jd.com/x", title: "罗技" },
    },
  );
  expect(reply.output).toEqual({ kind: "reply", text: "当前是京东" });
  const turn = loadTurn(dir, "cv_01", reply.turnId);
  expect(turn.assembled.currentTab).toEqual({ tab: 12, url: "https://item.jd.com/x", title: "罗技" });
  expect(turn.assembled.currentPage).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

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
  expect(ledger.liveTool).toBeNull();
  expect(ledger.userInputHistory).toEqual([]);
  const turn = loadTurn(dir, "cv_01", reply.turnId);
  expect(turn.assembled.currentPage).toBeNull();
  expect(turn.assembled.currentTab).toBeNull();
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
  const providerLog = loadProviderLog(dir, "cv_01");
  expect(providerLog).toHaveLength(1);
  expect(providerLog[0]!.turnId).toBe(reply.turnId);
  expect(providerLog[0]!.outbound).toBe(1);
  expect(providerLog[0]!.request.toolIds).toContain("finishTurn");
  expect(providerLog[0]!.response.finish).toBe("tool_calls");
  expect(providerLog[0]!.response.toolCalls[0]!.name).toBe("finishTurn");
  const transcript = readFileSync(join(dir, "conversations", "cv_01", "provider.md"), "utf8");
  expect(transcript).toContain(`## ${reply.turnId} / 1`);
  expect(transcript).toContain("### system");
  expect(transcript).toContain("### user");
  expect(transcript).toContain("你好");
  expect(transcript).toContain("### content");
  expect(transcript).toContain("action");
  expect(transcript).toContain("finishTurn");
  rmSync(dir, { recursive: true, force: true });
});

test("finishTurn 没有 action 就再出网一次", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-empty-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      content: "",
      toolCalls: [{ id: "call_01", name: "finishTurn", arguments: { reason: "用户问候，无需浏览器操作，结束本轮对话。", affectsPage: false } }],
    }),
    ok({
      finish: "tool_calls",
      content: "seen\n已问好\nreason\n收口\naction\n你好",
      toolCalls: [{ id: "call_02", name: "finishTurn", arguments: { reason: "补 action", affectsPage: false } }],
    }),
  ]);
  const reply = await handleTurn({ dataDir: dir, repoRoot, provider }, { userInput: "你好啊", submittedAt: "2026-09-06T00:00:00.000Z" });
  expect(reply.output).toEqual({ kind: "reply", text: "你好" });
  rmSync(dir, { recursive: true, force: true });
});

test("askUser 冻在追问", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-ask-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      content: "seen\n缺尺码\nreason\n问用户\naction\n要哪个尺码",
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
      content: "seen\n第二句\nreason\n收口\naction\n第二回",
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

test("开 Turn 不读页，模型 page.get_summary 后才填 currentPage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-page-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      content: "seen\n要看当前页\nreason\n先摘要\naction\npage.get_summary",
      toolCalls: [{ id: "call_01", name: "page.get_summary", arguments: { reason: "看当前页", affectsPage: false } }],
    }),
    ok({
      finish: "tool_calls",
      content: "seen\n已看到页\nreason\n收口\naction\n在看罗技",
      toolCalls: [{ id: "call_02", name: "finishTurn", arguments: { reason: "答完", affectsPage: false } }],
    }),
  ]);
  const host = {
    execute: async (name: string) => {
      if (name !== "page.get_summary") return { ok: false, error: name };
      return {
        ok: true,
        tab: 12,
        url: "https://item.jd.com/100012345678.html",
        title: "罗技 MX Master 3S 无线鼠标",
        description: "当前页面信息",
      };
    },
  };
  const reply = await handleTurn({ dataDir: dir, repoRoot, provider, host }, { userInput: "这是什么页", submittedAt: "2026-09-06T00:00:00.000Z" });
  expect(reply.output).toEqual({ kind: "reply", text: "在看罗技" });
  const turn = loadTurn(dir, "cv_01", reply.turnId);
  expect(turn.assembled.currentPage).toEqual({
    description: "当前页面信息",
    tab: 12,
    url: "https://item.jd.com/100012345678.html",
    title: "罗技 MX Master 3S 无线鼠标",
  });
  const ledger = loadLedger(dir, "cv_01");
  expect(ledger.toolIO[0]?.name).toBe("page.get_summary");
  expect(ledger.toolIO[0]?.turnId).toBe(reply.turnId);
  const session = await (await createServer({ dataDir: dir, repoRoot, provider: mock([]) }).fetch(new Request("http://127.0.0.1:18788/session"))).json() as { messages: { role: string; name?: string; text: string }[] };
  expect(session.messages.map((row) => row.role)).toEqual(["user", "tool", "tool", "tool", "assistant"]);
  expect(session.messages[1]?.text).toBe("先摘要");
  expect(session.messages[2]?.name).toBe("page.get_summary");
  expect(session.messages[2]?.text).toBe("看当前页");
  expect(session.messages[3]?.text).toBe("收口");
  expect(session.messages[4]?.text).toBe("在看罗技");
  rmSync(dir, { recursive: true, force: true });
});

test("web_search 走服务端执行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-search-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      content: "seen\n要搜价\nreason\n搜官网\naction\nweb_search",
      toolCalls: [{ id: "call_01", name: "web_search", arguments: { reason: "搜价", affectsPage: false, query: "罗技 MX Master 3S" } }],
    }),
    ok({
      finish: "tool_calls",
      content: "seen\n搜到了\nreason\n收口\naction\n官价 699",
      toolCalls: [{ id: "call_02", name: "finishTurn", arguments: { reason: "有价了", affectsPage: false } }],
    }),
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("duckduckgo")) {
      return new Response('<a href="https://html.duckduckgo.com/html/?uddg=https%3A%2F%2Fwww.logitech.com">hit</a>', { status: 200 });
    }
    return originalFetch(input);
  }) as typeof fetch;
  try {
    const reply = await handleTurn({ dataDir: dir, repoRoot, provider }, { userInput: "这鼠标官网多少钱", submittedAt: "2026-09-06T00:00:00.000Z" });
    expect(reply.output).toEqual({ kind: "reply", text: "官价 699" });
    const turn = loadTurn(dir, "cv_01", reply.turnId);
    expect(turn.assembled.toolIds).toContain("page.get_summary");
    expect(turn.assembled.toolIds).toContain("web_search");
    expect(turn.assembled.currentPage).toBeNull();
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
    { turnId: "tn_01", role: "tool", text: "收口" },
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
  const createdAgain = await (await server.fetch(new Request("http://127.0.0.1:18788/conversations/new", { method: "POST" }))).json();
  expect(createdAgain.conversationId).toBe("cv_03");
  const listedNew = await (await server.fetch(new Request("http://127.0.0.1:18788/conversations"))).json();
  expect(listedNew.items[0].conversationId).toBe("cv_03");
  expect(listedNew.items[0].preview).toBe("新会话");
  const deleted = await (await server.fetch(new Request("http://127.0.0.1:18788/conversations/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId: "cv_01" }),
  }))).json();
  expect(deleted.conversationId).toBe("cv_03");
  const after = await (await server.fetch(new Request("http://127.0.0.1:18788/conversations"))).json();
  expect(after.items.map((item: { conversationId: string }) => item.conversationId)).toEqual(["cv_03", "cv_02"]);
  rmSync(dir, { recursive: true, force: true });
});

test("catalog.add 把缺的工具挂进本轮", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-add-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      content: "seen\n缺截图\nreason\n补工具\naction\ncatalog.add",
      toolCalls: [{ id: "call_01", name: "catalog.add", arguments: { reason: "要截图", affectsPage: false, names: ["screenshot"] } }],
    }),
    ok({
      finish: "tool_calls",
      content: "seen\n已补上\nreason\n收口\naction\n补上了",
      toolCalls: [{ id: "call_02", name: "finishTurn", arguments: { reason: "补完", affectsPage: false } }],
    }),
  ]);
  const reply = await handleTurn(
    { dataDir: dir, repoRoot, provider, host: { execute: async () => ({ ok: false }) } },
    { userInput: "截一张", submittedAt: "2026-09-06T00:00:00.000Z" },
  );
  expect(reply.output).toEqual({ kind: "reply", text: "补上了" });
  const turn = loadTurn(dir, "cv_01", reply.turnId);
  expect(turn.assembled.toolIds).toContain("screenshot");
  expect(turn.assembled.toolIds).toContain("page.get_summary");
  rmSync(dir, { recursive: true, force: true });
});

test("到门槛时先裁 toolIds 再压缩记忆", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-compress-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      content: "seen\n记下\nreason\n写记忆并收口\naction\n记下了",
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
  const reply = await handleTurn({ dataDir: dir, repoRoot, provider, host: { execute: async () => ({ ok: false }) } }, {
    userInput: "查价",
    submittedAt: "2026-09-06T00:00:00.000Z",
  });
  const ledger = loadLedger(dir, "cv_01");
  expect(ledger.memoryIds.turn).toHaveLength(1);
  expect(loadMemory(dir, "cv_01", ledger.memoryIds.turn[0]!).compressed).toBe(false);
  expect(loadMemory(dir, "cv_01", ledger.memoryIds.project[0]!).compressed).toBe(false);
  const turn = loadTurn(dir, "cv_01", reply.turnId);
  turn.assembled.toolIds = ["see_page", "web_search", "screenshot", "cookies_get"];
  ledger.compressAt = 1;
  maybeCompress({
    dataDir: dir,
    ledger,
    turn,
    catalog: loadCatalog(repoRoot),
    coreToolIds: ["see_page", "web_search"],
    windowChars: 200000,
  });
  expect(turn.assembled.toolIds).toEqual(["see_page", "web_search"]);
  expect(loadMemory(dir, "cv_01", ledger.memoryIds.turn[0]!).compressed).toBe(true);
  expect(loadMemory(dir, "cv_01", ledger.memoryIds.conversation[0]!).compressed).toBe(true);
  expect(loadMemory(dir, "cv_01", ledger.memoryIds.project[0]!).compressed).toBe(false);
  expect(loadMemory(dir, "cv_01", ledger.memoryIds.turn[0]!).text).toBe("本轮用户要查鼠标价");
  const events = loadEvents(dir, "cv_01");
  expect(events.some((row) => row.kind === "compress")).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

test("队列和正在跑的工具出现在 /session", () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-live-"));
  const ledger = emptyLedger("cv_01");
  ledger.status = "running";
  ledger.active = { turnId: "tn_01" };
  ledger.turnIds = ["tn_01"];
  ledger.liveTool = { name: "see_page", callId: "call_01" };
  ledger.toolQueue = [
    { callId: "call_01", name: "see_page", arguments: { reason: "看当前页", affectsPage: false } },
    { callId: "call_02", name: "click", arguments: { reason: "点分类", affectsPage: true } },
  ];
  ledger.toolIO = [
    { callId: "call_00", name: "open_url", turnId: "tn_01", arguments: { reason: "打开站点", affectsPage: true }, return: { stage: "complete", totalChars: 2, text: "ok" } },
  ];
  saveLedger(dir, ledger);
  saveTurn(dir, {
    turnId: "tn_01",
    conversationId: "cv_01",
    status: "inferring",
    createdAt: "2026-09-06T00:00:00.000Z",
    completedAt: null,
    input: { text: "测这个站", submittedAt: "2026-09-06T00:00:00.000Z" },
    assembled: {

      baseToolsIds: [],
      toolIds: [],
      turnMemoryIds: [],
      conversationMemoryIds: [],
      projectMemoryIds: [],
      mcpIds: [],
      currentPage: null,
      currentTab: null,
    },
    output: null,
  });
  const view = sessionView(dir, "cv_01");
  expect(view.messages.map((row) => ({ role: row.role, name: row.name, live: row.live }))).toEqual([
    { role: "user", name: undefined, live: undefined },
    { role: "tool", name: "open_url", live: undefined },
    { role: "tool", name: "see_page", live: true },
    { role: "tool", name: "click", live: undefined },
  ]);
  expect(view.messages[1]?.text).toBe("打开站点");
  rmSync(dir, { recursive: true, force: true });
});

test("POST /stop 把 running 标成 paused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-stop-"));
  let release!: (result: { ok: boolean }) => void;
  const host = {
    execute: () => new Promise<{ ok: boolean }>((resolve) => {
      release = resolve;
    }),
  };
  const provider = mock([
    ok({
      finish: "tool_calls",
      content: "seen\n读页\nreason\n看\naction\nsee_page",
      toolCalls: [{ id: "call_01", name: "see_page", arguments: { reason: "看当前页", affectsPage: false } }],
    }),
  ]);
  const server = createServer({ dataDir: dir, repoRoot, provider, host });
  const pending = server.fetch(new Request("http://127.0.0.1:18788/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userInput: "看这页", submittedAt: "2026-09-06T00:00:00.000Z" }),
  }));
  await Bun.sleep(20);
  const stopped = await (await server.fetch(new Request("http://127.0.0.1:18788/stop", { method: "POST" }))).json() as { status: string };
  expect(stopped.status).toBe("paused");
  release({ ok: true });
  const reply = await pending.then((response) => response.json()) as { output: { kind: string; faultCode?: string } };
  expect(reply.output).toEqual({ kind: "error", faultCode: "stopped" });
  const session = await (await server.fetch(new Request("http://127.0.0.1:18788/session"))).json() as { status: string; messages: { text: string }[] };
  expect(session.status).toBe("paused");
  expect(session.messages.at(-1)?.text).toBe("已停止");
  rmSync(dir, { recursive: true, force: true });
});

test("arguments 不是 JSON 时好的工具照跑，坏的退回再出网", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-badjson-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      parseOk: false,
      schemaOk: false,
      faultCode: "arguments_not_json",
      detail: "page.type: Unexpected token",
      badName: "page.type",
      content: "seen\n输入\nreason\n填邮箱\naction\npage.type",
      toolCalls: [{ id: "call_01", name: "page.get_summary", arguments: { reason: "看页", affectsPage: false } }],
    }),
    ok({
      finish: "tool_calls",
      content: "seen\n已看到\nreason\n收口\naction\n注册页在",
      toolCalls: [{ id: "call_02", name: "finishTurn", arguments: { reason: "答完", affectsPage: false } }],
    }),
  ]);
  const host = {
    execute: async (name: string) => {
      if (name !== "page.get_summary") return { ok: false, error: name };
      return { ok: true, tab: 1, url: "https://example.com", title: "注册", description: "注册页" };
    },
  };
  const reply = await handleTurn({ dataDir: dir, repoRoot, provider, host }, { userInput: "测注册", submittedAt: "2026-09-06T00:00:00.000Z" });
  expect(reply.output).toEqual({ kind: "reply", text: "注册页在" });
  const ledger = loadLedger(dir, "cv_01");
  expect(ledger.status).toBe("idle");
  expect(ledger.toolIO.map((row) => row.name)).toEqual(["page.type", "page.get_summary", "finishTurn"]);
  expect(JSON.parse(ledger.toolIO[0]!.return.text).faultCode).toBe("arguments_not_json");
  rmSync(dir, { recursive: true, force: true });
});

test("缺字段写进 toolIO 再出网，不补齐", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-missing-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      parseOk: true,
      schemaOk: false,
      faultCode: "missing_required",
      missing: ["reason", "affectsPage"],
      badName: "page.type",
      detail: "page.type missing required: reason, affectsPage",
      content: "seen\n填邮箱\nreason\n输入\naction\npage.type",
      toolCalls: [{ id: "call_01", name: "page.type", arguments: { id: "e1", text: "a@b.com" } }],
    }),
    ok({
      finish: "tool_calls",
      content: "seen\n已记下缺字段\nreason\n收口\naction\n缺 reason 和 affectsPage",
      toolCalls: [{ id: "call_02", name: "finishTurn", arguments: { reason: "答完", affectsPage: false } }],
    }),
  ]);
  const reply = await handleTurn({ dataDir: dir, repoRoot, provider }, { userInput: "填邮箱", submittedAt: "2026-09-06T00:00:00.000Z" });
  expect(reply.output).toEqual({ kind: "reply", text: "缺 reason 和 affectsPage" });
  const ledger = loadLedger(dir, "cv_01");
  expect(ledger.status).toBe("idle");
  expect(ledger.toolIO[0]!.name).toBe("page.type");
  expect(JSON.parse(ledger.toolIO[0]!.return.text)).toMatchObject({
    ok: false,
    faultCode: "missing_required",
    missing: ["reason", "affectsPage"],
    toolName: "page.type",
  });
  expect(ledger.toolIO[0]!.arguments).toEqual({ id: "e1", text: "a@b.com" });
  rmSync(dir, { recursive: true, force: true });
});

test("stop 没有 tool_calls 就写 needFinishTurn 再出网", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-need-finish-"));
  const provider = mock([
    ok({
      finish: "stop",
      content: "seen\n说完了\nreason\n收口\naction\n测完了",
      toolCalls: [],
    }),
    ok({
      finish: "tool_calls",
      content: "seen\n已看到提示\nreason\n收口\naction\n测完了",
      toolCalls: [{ id: "call_01", name: "finishTurn", arguments: { reason: "答完", affectsPage: false } }],
    }),
  ]);
  const reply = await handleTurn({ dataDir: dir, repoRoot, provider }, { userInput: "测完了吗", submittedAt: "2026-09-06T00:00:00.000Z" });
  expect(reply.output).toEqual({ kind: "reply", text: "测完了" });
  const ledger = loadLedger(dir, "cv_01");
  expect(ledger.toolIO[0]!.name).toBe("finishTurn");
  expect(ledger.toolIO[0]!.return.text).toContain("没有 tool_calls");
  rmSync(dir, { recursive: true, force: true });
});

test("submitGoal 写入当前目标，再交一次旧目标进 history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-goal-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      content: "seen\n空目标\nreason\n先交目标\naction\nsubmitGoal",
      toolCalls: [{ id: "call_01", name: "submitGoal", arguments: { reason: "立目标", affectsPage: false, goal: "测这个站点" } }],
    }),
    ok({
      finish: "tool_calls",
      content: "seen\n目标改了\nreason\n收窄\naction\nsubmitGoal",
      toolCalls: [{ id: "call_02", name: "submitGoal", arguments: { reason: "改目标", affectsPage: false, goal: "测登录页" } }],
    }),
    ok({
      finish: "tool_calls",
      content: "seen\n已记下\nreason\n收口\naction\n目标改成测登录页",
      toolCalls: [{ id: "call_03", name: "finishTurn", arguments: { reason: "答完", affectsPage: false } }],
    }),
  ]);
  const reply = await handleTurn({ dataDir: dir, repoRoot, provider }, { userInput: "测这个站点", submittedAt: "2026-09-06T00:00:00.000Z" });
  expect(reply.output).toEqual({ kind: "reply", text: "目标改成测登录页" });
  const ledger = loadLedger(dir, "cv_01");
  expect(ledger.goal).toBe("测登录页");
  expect(ledger.goalHistory).toEqual(["测这个站点"]);
  rmSync(dir, { recursive: true, force: true });
});

test("notes.write 按 key 写入，notes.delete 删除", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-notes-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      content: "seen\n记下候选\nreason\n自管\naction\nnotes.write",
      toolCalls: [{ id: "call_01", name: "notes.write", arguments: { reason: "记下", affectsPage: false, key: "candidate", value: "罗技 MX Master 3S" } }],
    }),
    ok({
      finish: "tool_calls",
      content: "seen\n改候选\nreason\n覆盖\naction\nnotes.write",
      toolCalls: [{ id: "call_02", name: "notes.write", arguments: { reason: "改", affectsPage: false, key: "candidate", value: "MX Master 3S 黑" } }],
    }),
    ok({
      finish: "tool_calls",
      content: "seen\n删掉\nreason\n不用了\naction\nnotes.delete",
      toolCalls: [{ id: "call_03", name: "notes.delete", arguments: { reason: "删", affectsPage: false, key: "candidate" } }],
    }),
    ok({
      finish: "tool_calls",
      content: "seen\n已空\nreason\n收口\naction\n笔记已删",
      toolCalls: [{ id: "call_04", name: "finishTurn", arguments: { reason: "答完", affectsPage: false } }],
    }),
  ]);
  const reply = await handleTurn({ dataDir: dir, repoRoot, provider }, { userInput: "先记下再删", submittedAt: "2026-09-06T00:00:00.000Z" });
  expect(reply.output).toEqual({ kind: "reply", text: "笔记已删" });
  const ledger = loadLedger(dir, "cv_01");
  expect(ledger.notes).toEqual({});
  expect(ledger.toolIO.map((row) => row.name)).toEqual(["notes.write", "notes.write", "notes.delete", "finishTurn"]);
  rmSync(dir, { recursive: true, force: true });
});

test.each(["provider", "browser"])("停止后启动新轮，旧 %s 返回不会覆盖新轮", async (waitingOn) => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-stop-restart-"));
  const finish = ok({ finish: "tool_calls", content: "action\n完成", toolCalls: [
    { id: "finish", name: "finishTurn", arguments: { reason: "完成", affectsPage: false } },
  ] });
  let releaseOld!: () => void;
  let releaseNew!: (value: CompletionResult) => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  const provider: Provider = { complete: () => {
    if (calls++ > 0) return new Promise((resolve) => { releaseNew = resolve; });
    if (waitingOn === "browser") return Promise.resolve(ok({ finish: "tool_calls", toolCalls: [
      { id: "page", name: "page.get_summary", arguments: { reason: "读取", affectsPage: false } },
    ] }));
    return new Promise((resolve) => { releaseOld = () => resolve(finish); started(); });
  } };
  const deps = { dataDir: dir, repoRoot, provider, host: { execute: () => new Promise<{ ok: boolean }>((resolve) => {
    releaseOld = () => resolve({ ok: true });
    started();
  }) } };
  try {
    const oldTurn = handleTurn(deps, { userInput: "旧轮", submittedAt: "now" });
    await waiting;
    stopTurn(dir);
    const newTurn = handleTurn(deps, { userInput: "新轮", submittedAt: "now" });
    const before = loadLedger(dir, "cv_01");
    const eventsBefore = loadEvents(dir, "cv_01");
    releaseOld();
    expect((await oldTurn).output).toEqual({ kind: "error", faultCode: "stopped" });
    expect(loadLedger(dir, "cv_01")).toEqual(before);
    expect(loadEvents(dir, "cv_01")).toEqual(eventsBefore);
    expect(loadTurn(dir, "cv_01", "tn_01").output).toEqual({ kind: "error", faultCode: "stopped" });
    releaseNew(finish);
    expect((await newTurn).output).toEqual({ kind: "reply", text: "完成" });
    expect(loadLedger(dir, "cv_01").turnIds).toEqual(["tn_01", "tn_02"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  { name: "page.get_dom", arguments: {}, faultCode: "unknown_tool" },
  { name: "page.get_summary", arguments: {}, faultCode: "missing_required" },
])("坏 JSON 前缀也校验 $faultCode", async (invalid) => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-prefix-schema-"));
  const executed: string[] = [];
  try {
    const provider = mock([
      ok({ finish: "tool_calls", parseOk: false, schemaOk: false, faultCode: "arguments_not_json",
        badName: "page.type", toolCalls: [{ id: "bad-prefix", name: invalid.name, arguments: invalid.arguments }] }),
      ok({ finish: "tool_calls", content: "action\n结束", toolCalls: [
        { id: "finish", name: "finishTurn", arguments: { reason: "完成", affectsPage: false } },
      ] }),
    ]);
    const reply = await handleTurn({ dataDir: dir, repoRoot, provider, host: { execute: async (name) => {
      executed.push(name);
      return { ok: true };
    } } }, { userInput: "测试", submittedAt: "now" });
    expect(reply.output).toEqual({ kind: "reply", text: "结束" });
    expect(executed).toEqual([]);
    expect(loadLedger(dir, "cv_01").toolIO.some((row) => row.return.text.includes(invalid.faultCode))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("第20次出网 content 为空但 finishTurn.text 有正文时正常结束", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-last-finish-"));
  try {
    const steps = Array.from({ length: 19 }, (_, i) => ok({
      finish: "tool_calls", content: "", toolCalls: [{
        id: `note_${i}`, name: "notes.write", arguments: { reason: "记录已确认的进展", affectsPage: false, key: "progress", value: String(i) },
      }],
    }));
    steps.push(ok({ finish: "tool_calls", content: "", toolCalls: [{
      id: "final", name: "finishTurn", arguments: { reason: "已完成检查，可以报告结果", affectsPage: false, text: "检查完成，已确认搜索可用。" },
    }] }));
    const reply = await handleTurn({ dataDir: dir, repoRoot, provider: mock(steps) }, { userInput: "检查搜索", submittedAt: new Date().toISOString() });
    expect(reply.output).toEqual({ kind: "reply", text: "检查完成，已确认搜索可用。" });
    expect(loadLedger(dir, reply.conversationId).status).toBe("idle");
    expect(loadEvents(dir, reply.conversationId).filter(e => e.kind === "provider-response")).toHaveLength(20);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("content 为空时 askUser.question 仍能展示问题和选项", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-question-"));
  try {
    const reply = await handleTurn({ dataDir: dir, repoRoot, provider: mock([ok({ finish: "tool_calls", content: "", toolCalls: [{
      id: "ask", name: "askUser", arguments: { reason: "需要确定检查范围", affectsPage: false, question: "先检查哪个页面？", choice: ["首页", "搜索页"] },
    }] })]) }, { userInput: "检查网站", submittedAt: new Date().toISOString() });
    expect(reply.output).toEqual({ kind: "ask", question: "先检查哪个页面？\n选项：首页 / 搜索页" });
    expect(sessionView(dir, reply.conversationId).pendingAsk).toMatchObject({ question: "先检查哪个页面？\n选项：首页 / 搜索页", choice: ["首页", "搜索页"] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
