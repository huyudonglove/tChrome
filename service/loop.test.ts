import { loadContextRecord } from "./runtime/records.ts";
import { loadMemories, loadMemory, saveMemory } from "./memory/store.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTurn } from "./runtime/loop.ts";
import { createServer } from "./server.ts";
import { executorVersion } from "./executor-version.ts";
import { createProvider } from "./provider/uuapi.ts";
import { createToolBridge } from "./runtime/bridge.ts";
import { stopTurn, emptyLedger, loadEvents, loadLedger, loadProviderLog, loadSession, loadTurn, saveLedger, saveTurn, sessionView } from "./runtime/store.ts";
import { compressRecords } from "./agents/compression/index.ts";
import { loadIndex } from "./context-archive/store.ts";
import type { CompletionResult, Provider } from "./types.ts";

const repoRoot = join(import.meta.dir, "..");

const ok = (partial: Partial<CompletionResult> & Pick<CompletionResult, "finish">): CompletionResult => ({
  content: "",
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

test("每次主模型请求刷新 openTabs，焦点变化不覆盖页面观察，读取失败不冒充空列表", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-tabs-"));
  try {
    let snapshots = 0, requests = 0;
    const host = {
      readOpenTabs: async () => {
        snapshots++;
        if (snapshots === 3) throw new Error("读取窗口失败");
        return { ok: true as const, windows: [{windowId: 1, focused: true, tabs: [
          {tabId: 12, url: "https://example.com/work", title: "工作页面", active: snapshots === 1},
          {tabId: 13, url: "https://example.com/other", title: "其他页面", active: snapshots !== 1},
        ]}] };
      },
      execute: async (_name: string, args: Record<string, unknown>) => {
        expect(args.tabId).toBe(12);
        return {ok: true, tabId: 12, url: "https://example.com/work", title: "工作页面", description: "已观察原页面"};
      },
    };
    const provider: Provider = {complete: async input => {
      requests++;
      const body = input.messages[1]!.content;
      const snapshot = JSON.parse(body.split("#openTabs\n")[1]!.split("\n#pageObservedHistory")[0]!.trim());
      expect(snapshots).toBe(requests);
      if (requests === 1) expect(snapshot.windows[0].tabs[0].active).toBe(true);
      if (requests === 2) {
        expect(snapshot.windows[0].tabs[1].active).toBe(true);
        expect(body).toContain("已观察原页面");
      }
      if (requests === 3) expect(snapshot).toEqual({ok: false, error: "读取窗口失败"});
      return ok({finish: "tool_calls", toolCalls: [requests < 3
        ? {id: `read_${requests}`, name: "page.get_summary", arguments: {tabId: 12, reason: "查看原页面", affectsPage: false}}
        : {id: "finish", name: "finishTurn", arguments: {text: "完成"}}]});
    }};
    const reply = await handleTurn({dataDir: dir, repoRoot, provider, host}, {userInput: "继续原页面", submittedAt: "now"});
    expect(reply.output).toEqual({kind: "reply", text: "完成"});
    const turn = loadTurn(dir, "cv_01", reply.turnId);
    expect(turn.assembled.currentPage?.tabId).toBe(12);
    expect(turn.assembled.pageObservedHistory).toHaveLength(2);
  } finally {rmSync(dir, {recursive: true, force: true});}
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
      toolCalls: [{ id: "call_01", name: "finishTurn", arguments: { text: "你好" } }],
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
  expect(turn.assembled.openTabs.ok).toBe(false);
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
  expect(transcript).toContain("finishTurn");
  rmSync(dir, { recursive: true, force: true });
});

test("finishTurn 正文为空时要求修正参数后再调用", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-empty-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      content: "",
      toolCalls: [{ id: "call_01", name: "finishTurn", arguments: { text: "", reason: "用户问候，无需浏览器操作，结束本轮对话。", affectsPage: false } }],
    }),
    ok({
      finish: "tool_calls",
      content: "",
      toolCalls: [{ id: "call_02", name: "finishTurn", arguments: { text: "你好", reason: "补充回复正文", affectsPage: false } }],
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
      content: "",
      toolCalls: [{ id: "call_02", name: "askUser", arguments: { question: "要哪个尺码", reason: "缺尺码", affectsPage: false, choice: ["S", "M"] } }],
    }),
  ]);
  const reply = await handleTurn({ dataDir: dir, repoRoot, provider }, { userInput: "买这件", submittedAt: "2026-09-06T00:00:00.000Z" });
  expect(reply.output.kind).toBe("ask");
  if (reply.output.kind === "ask") expect(reply.output.question).toContain("要哪个尺码");
  const ledger = loadLedger(dir, "cv_01");
  expect(ledger.status).toBe("waiting_human");
  rmSync(dir, { recursive: true, force: true });
});

test.each([
  { name: "finishTurn", args: {}, faultCode: "missing_required" },
  { name: "finishTurn", args: { text: "   " }, faultCode: "wrong_type" },
  { name: "finishTurn", args: { text: "完成", affectsPage: true }, faultCode: "wrong_type" },
  { name: "askUser", args: { choice: [] }, faultCode: "missing_required" },
  { name: "askUser", args: { question: 42, choice: [] }, faultCode: "wrong_type" },
])("$name 的无效正文不能由模型 content 补齐", async ({ name, args, faultCode }) => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-explicit-message-"));
  try {
    const provider = mock([ok({
      finish: "tool_calls", content: "reason\n这是旧协议内容\naction\n不应展示的正文",
      toolCalls: [{ id: "bad", name, arguments: { reason: "完成当前步骤", affectsPage: false, ...args } }],
    })]);
    const reply = await handleTurn({ dataDir: dir, repoRoot, provider }, { userInput: "测试", submittedAt: "now" });
    expect(reply.output).toEqual({ kind: "error", faultCode, toolName: name, detail: expect.any(String) });
    expect(loadLedger(dir, reply.conversationId).pendingAsk).toBeNull();
    expect(JSON.stringify(sessionView(dir, reply.conversationId).messages)).not.toContain("不应展示的正文");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("下一句开新 Turn 并追加 userInputHistory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-hist-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      toolCalls: [{ id: "call_01", name: "finishTurn", arguments: { text: "你好", reason: "先回", affectsPage: false } }],
    }),
    ok({
      finish: "tool_calls",
      content: "",
      toolCalls: [{ id: "call_02", name: "finishTurn", arguments: { text: "第二回", reason: "再回", affectsPage: false } }],
    }),
  ]);
  const deps = { dataDir: dir, repoRoot, provider };
  await handleTurn(deps, { userInput: "第一句", submittedAt: "2026-09-06T00:00:00.000Z" });
  const second = await handleTurn(deps, { userInput: "第二句", submittedAt: "2026-09-06T00:00:01.000Z" });
  expect(second.output).toEqual({ kind: "reply", text: "第二回" });
  const ledger = loadLedger(dir, "cv_01");
  expect(ledger.userInputHistory).toEqual([{ id: expect.any(String), turnId: "tn_01", userInput: "第一句", submittedAt: "2026-09-06T00:00:00.000Z" }]);
  const firstInput = ledger.userInputHistory[0]!;
  expect(firstInput.id).toBe(loadTurn(dir, "cv_01", "tn_01").input.id);
  expect(JSON.parse(loadContextRecord(dir, "cv_01", "userInput", firstInput.id)!)).toEqual(firstInput);
  ledger.userInputHistory = [];
  saveLedger(dir, ledger);
  expect(JSON.parse(loadContextRecord(dir, "cv_01", "userInput", firstInput.id)!)).toEqual(firstInput);
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
        toolCalls: [{ id: "call_01", name: "finishTurn", arguments: { text: "你好", reason: "答完", affectsPage: false } }],
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
      content: "",
      toolCalls: [{ id: "call_01", name: "page.get_summary", arguments: { tabId: 12, reason: "看当前页", affectsPage: false } }],
    }),
    ok({
      finish: "tool_calls",
      content: "",
      toolCalls: [{ id: "call_02", name: "finishTurn", arguments: { text: "在看罗技", reason: "答完", affectsPage: false } }],
    }),
  ]);
  const host = {
    execute: async (name: string) => {
      if (name !== "page.get_summary") return { ok: false, error: name };
      return {
        ok: true,
        tabId: 12,
        url: "https://item.jd.com/100012345678.html",
        title: "罗技 MX Master 3S 无线鼠标",
        description: "当前页面信息",
      };
    },
  };
  const reply = await handleTurn({ dataDir: dir, repoRoot, provider, host }, { userInput: "这是什么页", submittedAt: "2026-09-06T00:00:00.000Z" });
  expect(reply.output).toEqual({ kind: "reply", text: "在看罗技" });
  const turn = loadTurn(dir, "cv_01", reply.turnId);
  expect(turn.assembled.currentPage).toMatchObject({
    description: "当前页面信息",
    tabId: 12,
    url: "https://item.jd.com/100012345678.html",
    title: "罗技 MX Master 3S 无线鼠标",
  });
  const ledger = loadLedger(dir, "cv_01");
  expect(ledger.toolIO[0]?.name).toBe("page.get_summary");
  expect(ledger.toolIO[0]?.turnId).toBe(reply.turnId);
  const session = await (await createServer({ dataDir: dir, repoRoot, provider: mock([]) }).fetch(new Request("http://127.0.0.1:18788/session"))).json() as { messages: { role: string; name?: string; text: string }[] };
  expect(session.messages.map((row) => row.role)).toEqual(["user", "tool", "assistant"]);
  expect(session.messages[1]?.name).toBe("page.get_summary");
  expect(session.messages[1]?.text).toBe("看当前页");
  expect(session.messages[2]?.text).toBe("在看罗技");
  rmSync(dir, { recursive: true, force: true });
});

test("web_search 走服务端执行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-search-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      content: "",
      toolCalls: [{ id: "call_01", name: "web_search", arguments: { reason: "搜价", affectsPage: false, query: "罗技 MX Master 3S" } }],
    }),
    ok({
      finish: "tool_calls",
      content: "",
      toolCalls: [{ id: "call_02", name: "finishTurn", arguments: { text: "官价 699", reason: "有价了", affectsPage: false } }],
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
    expect(turn.assembled.baseToolsIds).toContain("page.get_summary");
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

test("Gemini grounding 写入 toolIO 但不进入执行队列或 usage.toolCalls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-grounding-"));
  const provider = mock([
    ok({
      finish: "stop",
      content: "根据搜索到的资料，官价约 699。",
      grounding: {
        name: "google_search",
        queries: ["罗技 MX Master 3S 官价"],
        sources: [{ title: "Logitech", uri: "https://www.logitech.com/mx-master-3s" }],
      },
    }),
    ok({
      finish: "tool_calls",
      toolCalls: [{ id: "call_finish", name: "finishTurn", arguments: { text: "官价 699" } }],
    }),
  ]);
  try {
    const reply = await handleTurn({ dataDir: dir, repoRoot, provider }, { userInput: "这鼠标官网多少钱", submittedAt: "now" });
    expect(reply.output).toEqual({ kind: "reply", text: "官价 699" });
    const ledger = loadLedger(dir, "cv_01");
    const search = ledger.toolIO.find((row) => row.name === "google_search");
    expect(search?.callId).toMatch(/^call_\d{2,}$/);
    expect(search?.arguments).toEqual({ reason: "模型侧内置搜索已完成", queries: ["罗技 MX Master 3S 官价"] });
    expect(JSON.parse(search!.return.text)).toEqual({
      ok: true,
      provider: "gemini",
      queries: ["罗技 MX Master 3S 官价"],
      sources: [{ title: "Logitech", uri: "https://www.logitech.com/mx-master-3s" }],
    });
    expect(ledger.toolQueue).toEqual([]);
    expect(ledger.lastAction).toEqual({
      batchId: "batch_01",
      turnId: reply.turnId,
      calls: [
        { callId: "call_03", name: "finishTurn" },
      ],
    });
    const turn = loadTurn(dir, "cv_01", reply.turnId);
    // Only the Runtime-executed finishTurn counts; provider-side search does not.
    expect(turn.usage?.toolCalls).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /tool-request 和 POST /tool-result 对上", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-bridge-"));
  const bridge = createToolBridge(dir);
  const server = createServer({ dataDir: dir, repoRoot, provider: mock([]), bridge });
  const empty = await server.fetch(new Request(`http://127.0.0.1:18788/tool-request?executorVersion=${executorVersion(repoRoot)}`));
  expect(await empty.json()).toEqual({ request: null, executorVersion: executorVersion(repoRoot) });
  const pending = bridge.execute("see_page", {});
  const listed = await server.fetch(new Request(`http://127.0.0.1:18788/tool-request?executorVersion=${executorVersion(repoRoot)}`));
  const body = await listed.json() as { request: { id: string; name: string } };
  expect(body.request.name).toBe("see_page");
  const posted = await server.fetch(new Request(`http://127.0.0.1:18788/tool-result?executorVersion=${executorVersion(repoRoot)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: body.request.id, result: { ok: true, tabId: 3, url: "https://example.com", title: "ex" } }),
  }));
  expect(await posted.json()).toEqual({ ok: true });
  expect(await pending).toEqual({ ok: true, tabId: 3, url: "https://example.com", title: "ex" });
  rmSync(dir, { recursive: true, force: true });
});

test("GET /session 还原消息，切会话改 session.json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-session-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      toolCalls: [{ id: "call_01", name: "finishTurn", arguments: { text: "你好", reason: "答完", affectsPage: false } }],
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

test("归档历史工具结果保留工具能力、记忆索引和原始记忆", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-compress-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      content: "",
      toolCalls: [
        {
          id: "call_01",
          name: "memory.write",
          arguments: {
            reason: "记下",
            affectsPage: false,
            conversationMemory: ["本轮用户要查鼠标价", "用户在核对罗技 MX Master 3S"],
            projectMemory: ["项目偏好：查官网价"],
          },
        },
        { id: "call_02", name: "finishTurn", arguments: { text: "记下了", reason: "答完", affectsPage: false } },
      ],
    }),
  ]);
  const reply = await handleTurn({ dataDir: dir, repoRoot, provider, host: { execute: async () => ({ ok: false }) } }, {
    userInput: "查价",
    submittedAt: "2026-09-06T00:00:00.000Z",
  });
  const ledger = loadLedger(dir, "cv_01");
  expect(ledger.memoryIds.conversation).toHaveLength(2);
  const turn = loadTurn(dir, "cv_01", reply.turnId);
  turn.assembled.toolIds = ["see_page", "web_search", "capture_page", "cookies_get"];
  ledger.compressAt = 1;
  const memoryIdsBefore = structuredClone(ledger.memoryIds);
  ledger.toolIO.unshift({ callId: "call_old", name: "web_search", turnId: turn.turnId, arguments: {}, return: { stage: "complete", text: "旧证据", totalChars: 3 } });
  await compressRecords({ dataDir: dir, conversationId: ledger.conversationId, repoRoot,
    module: "conversationHistory", records: [{ id: "tool_old", content: ledger.toolIO[0]! }],
    provider: { complete: async () => ok({ finish: "tool_calls", toolCalls: [{id:"summary",name:"submitTurnSummaries",arguments:{summaries:[{turnId:turn.turnId,tag:"旧查询",userRequest:"查询",actions:"旧工具提供了旧证据",result:"已取得旧证据"}]}}] }) },
  });
  expect(turn.assembled.toolIds).toEqual(["see_page", "web_search", "capture_page", "cookies_get"]);
  expect(ledger.memoryIds).toEqual(memoryIdsBefore);
  expect(ledger.toolIO).toHaveLength(3);
  expect(loadIndex(dir, ledger.conversationId, "conversationHistory").coveredSourceIds).toEqual(["tool_old"]);
  expect(loadMemory(dir, "cv_01", ledger.memoryIds.conversation[0]!).text).toBe("本轮用户要查鼠标价");

  rmSync(dir, { recursive: true, force: true });
});

test("记忆效果失败进入 toolIO，同批工具继续，模型收到错误后决定收口", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-memory-effect-failure-"));
  try {
    saveMemory(dir, "cv_01", { memoryId: "lm_01", turnId: "tn_old", layer: "project", text: "已有记忆", createdAt: "now", sourceCallId: "call_old" });
    let requests = 0;
    const provider: Provider = { complete: async input => {
      if (++requests === 1) return ok({ finish: "tool_calls", toolCalls: [
        { id: "memory", name: "memory.write", arguments: { reason: "记录", affectsPage: false, conversationMemory: ["本轮已写入"], projectMemory: ["不能覆盖"] } },
        { id: "next", name: "notes.write", arguments: { reason: "下一步", affectsPage: false, key: "next", value: "已执行" } },
      ] });
      expect(input.messages[1]!.content).toContain('"faultCode": "file_exists"');
      expect(input.messages[1]!.content).toContain("本轮已写入");
      expect(input.messages[1]!.content).toContain("已执行");
      return ok({ finish: "tool_calls", toolCalls: [{ id: "finish", name: "finishTurn", arguments: { text: "会话记忆已保存，长期记忆写入冲突" } }] });
    } };
    const reply = await handleTurn({ dataDir: dir, repoRoot, provider }, { userInput: "记录", submittedAt: "now" });
    expect(reply.output.kind).toBe("reply");
    expect(requests).toBe(2);
    const ledger = loadLedger(dir, "cv_01");
    expect(ledger).toMatchObject({ status: "idle", active: null, liveTool: null, toolQueue: [], memoryIds: { conversation: ["mm_01"] }, notes: { next: "已执行" } });
    expect(loadMemory(dir, "cv_01", "mm_01").text).toBe("本轮已写入");
    expect(loadMemory(dir, "cv_01", "lm_01").text).toBe("已有记忆");
    expect(JSON.parse(ledger.toolIO[0]!.return.text)).toMatchObject({ ok: false, faultCode: "file_exists", toolName: "memory.write" });
    const toolEvent = loadEvents(dir, "cv_01").find(event => event.kind === "tool");
    expect(JSON.parse((toolEvent!.data.return as {text:string}).text).ok).toBe(false);
    expect(loadTurn(dir, "cv_01", reply.turnId).status).toBe("completed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("队列和正在跑的工具出现在 /session", () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-live-"));
  const ledger = emptyLedger("cv_01");
  ledger.status = "running";
  ledger.active = { turnId: "tn_01" };
  ledger.turnIds = ["tn_01"];
  ledger.liveTool = { name: "see_page", callId: "call_01" };
  ledger.toolQueue = [
    { callId: "call_01", name: "page.get_summary", arguments: { tabId: 12, reason: "看当前页", affectsPage: false } },
    { callId: "call_02", name: "click", arguments: { tabId: 12, reason: "点分类", affectsPage: true } },
  ];
  ledger.toolIO = [
    { callId: "call_00", name: "open_url", turnId: "tn_01", arguments: { reason: "打开站点", affectsPage: true }, return: { stage: "complete", totalChars: 2, text: "ok" } },
  ];
  saveLedger(dir, ledger);
  saveTurn(dir, {
    turnId: "tn_01",
    conversationId: "cv_01",
    goalChanges: [],
    status: "inferring",
    createdAt: "2026-09-06T00:00:00.000Z",
    completedAt: null,
    input: { id: "input_fixture", text: "测这个站", submittedAt: "2026-09-06T00:00:00.000Z" },
    assembled: {

      baseToolsIds: [],
      toolIds: [],

      conversationMemoryIds: [],
      projectMemoryIds: [],
      mcpIds: [],
      currentPage: null, pageObservedHistory: [],
      openTabs: { ok: true, windows: [] },
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
      content: "",
      toolCalls: [{ id: "call_01", name: "page.get_summary", arguments: { tabId: 12, reason: "看当前页", affectsPage: false } }],
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
      content: "",
      toolCalls: [{ id: "call_01", name: "page.get_summary", arguments: { tabId: 12, reason: "看页", affectsPage: false } }],
    }),
    ok({
      finish: "tool_calls",
      content: "",
      toolCalls: [{ id: "call_02", name: "finishTurn", arguments: { text: "注册页在", reason: "答完", affectsPage: false } }],
    }),
  ]);
  const host = {
    execute: async (name: string) => {
      if (name !== "page.get_summary") return { ok: false, error: name };
      return { ok: true, tabId: 1, url: "https://example.com", title: "注册", description: "注册页" };
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
      content: "",
      toolCalls: [{ id: "call_01", name: "page.type", arguments: { tabId: 12, id: "e1", text: "a@b.com" } }],
    }),
    ok({
      finish: "tool_calls",
      content: "",
      toolCalls: [{ id: "call_02", name: "finishTurn", arguments: { text: "缺 reason 和 affectsPage", reason: "答完", affectsPage: false } }],
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
  expect(ledger.toolIO[0]!.arguments).toEqual({ tabId: 12, id: "e1", text: "a@b.com" });
  rmSync(dir, { recursive: true, force: true });
});

test("stop 没有 tool_calls 就写 needFinishTurn 再出网", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-need-finish-"));
  const provider = mock([
    ok({
      finish: "stop",
      content: "",
      toolCalls: [],
    }),
    ok({
      finish: "tool_calls",
      content: "",
      toolCalls: [{ id: "call_01", name: "finishTurn", arguments: { text: "测完了", reason: "答完", affectsPage: false } }],
    }),
  ]);
  const reply = await handleTurn({ dataDir: dir, repoRoot, provider }, { userInput: "测完了吗", submittedAt: "2026-09-06T00:00:00.000Z" });
  expect(reply.output).toEqual({ kind: "reply", text: "测完了" });
  const ledger = loadLedger(dir, "cv_01");
  expect(ledger.toolIO[0]!.name).toBe("finishTurn");
  expect(ledger.toolIO[0]!.return.text).toContain("没有 tool_calls");
  rmSync(dir, { recursive: true, force: true });
});

test("submitGoal 创建父子目标并在后续轮次按稳定 ID 更新", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-goal-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      content: "",
      toolCalls: [{ id: "call_01", name: "submitGoal", arguments: { reason: "立目标", affectsPage: false, goal: "测这个站点" } }],
    }),
    ok({
      finish: "tool_calls",
      content: "",
      toolCalls: [{ id: "call_02", name: "submitGoal", arguments: { reason: "开始子任务", affectsPage: false, parentId: "goal_01", goal: "测登录页" } }],
    }),
    ok({
      finish: "tool_calls",
      content: "",
      toolCalls: [{ id: "call_03", name: "finishTurn", arguments: { text: "目标改成测登录页", reason: "答完", affectsPage: false } }],
    }),
  ]);
  const reply = await handleTurn({ dataDir: dir, repoRoot, provider }, { userInput: "测这个站点", submittedAt: "2026-09-06T00:00:00.000Z" });
  expect(reply.output).toEqual({ kind: "reply", text: "目标改成测登录页" });
  const ledger = loadLedger(dir, "cv_01");
  expect(ledger.currentGoalId).toBe("subgoal_01");
  expect(ledger.goals.map(({ id, parentId, goal, status }) => ({ id, parentId, goal, status }))).toEqual([
    { id: "goal_01", parentId: null, goal: "测这个站点", status: "active" },
    { id: "subgoal_01", parentId: "goal_01", goal: "测登录页", status: "active" },
  ]);
  expect(JSON.parse(ledger.toolIO.find(item => item.name === "submitGoal")!.return.text)).toMatchObject({ ok: true, record: { id: "goal_01" } });
  const nextProvider = mock([
    ok({ finish: "tool_calls", toolCalls: [{ id: "call_04", name: "submitGoal", arguments: { reason: "已验证", affectsPage: false, id: "subgoal_01", status: "completed" } }] }),
    ok({ finish: "tool_calls", toolCalls: [{ id: "call_05", name: "finishTurn", arguments: { text: "登录页通过" } }] }),
  ]);
  await handleTurn({ dataDir: dir, repoRoot, provider: nextProvider }, { userInput: "登录页通过了", submittedAt: "2026-09-06T00:01:00.000Z" });
  const completed = loadLedger(dir, "cv_01");
  expect(completed.currentGoalId).toBe("goal_01");
  expect(completed.goals).toHaveLength(2);
  expect(completed.goals.find(goal => goal.id === "subgoal_01")).toMatchObject({ parentId: "goal_01", status: "completed", goal: "测登录页" });
  expect(loadTurn(dir, "cv_01", reply.turnId).goalChanges.at(-1)?.status).toBe("active");
  rmSync(dir, { recursive: true, force: true });
});

test("notes.write 按 key 写入，notes.delete 删除", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-notes-"));
  const provider = mock([
    ok({
      finish: "tool_calls",
      content: "",
      toolCalls: [{ id: "call_01", name: "notes.write", arguments: { reason: "记下", affectsPage: false, key: "candidate", value: "罗技 MX Master 3S" } }],
    }),
    ok({
      finish: "tool_calls",
      content: "",
      toolCalls: [{ id: "call_02", name: "notes.write", arguments: { reason: "改", affectsPage: false, key: "candidate", value: "MX Master 3S 黑" } }],
    }),
    ok({
      finish: "tool_calls",
      content: "",
      toolCalls: [{ id: "call_03", name: "notes.delete", arguments: { reason: "删", affectsPage: false, key: "candidate" } }],
    }),
    ok({
      finish: "tool_calls",
      content: "",
      toolCalls: [{ id: "call_04", name: "finishTurn", arguments: { text: "笔记已删", reason: "答完", affectsPage: false } }],
    }),
  ]);
  const reply = await handleTurn({ dataDir: dir, repoRoot, provider }, { userInput: "先记下再删", submittedAt: "2026-09-06T00:00:00.000Z" });
  expect(reply.output).toEqual({ kind: "reply", text: "笔记已删" });
  const ledger = loadLedger(dir, "cv_01");
  expect(ledger.notes).toEqual({});
  expect(ledger.toolIO.map((row) => row.name)).toEqual(["notes.write", "notes.write", "notes.delete", "finishTurn"]);
  rmSync(dir, { recursive: true, force: true });
});

test.each(["provider", "provider-reject", "browser", "browser-reject"])("停止后启动新轮，旧 %s 返回不会覆盖新轮", async (waitingOn) => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-stop-restart-"));
  const finish = ok({ finish: "tool_calls", content: "", toolCalls: [
    { id: "finish", name: "finishTurn", arguments: { text: "完成", reason: "完成", affectsPage: false } },
  ] });
  let releaseOld!: () => void;
  let releaseNew!: (value: CompletionResult) => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  const provider: Provider = { complete: () => {
    if (calls++ > 0) return new Promise((resolve) => { releaseNew = resolve; });
    if (waitingOn.startsWith("browser")) return Promise.resolve(ok({ finish: "tool_calls", toolCalls: [
      { id: "page", name: "page.get_summary", arguments: { tabId: 12, reason: "读取", affectsPage: false } },
    ] }));
    return new Promise((resolve, reject) => { releaseOld = () => waitingOn === "provider-reject" ? reject(new Error("aborted provider")) : resolve(finish); started(); });
  } };
  const deps = { dataDir: dir, repoRoot, provider, host: { execute: () => new Promise<{ ok: boolean }>((resolve, reject) => {
    releaseOld = () => waitingOn === "browser-reject" ? reject(new Error("aborted host")) : resolve({ ok: true });
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
  { name: "page.get_summary", arguments: { tabId: 12,}, faultCode: "missing_required" },
])("坏 JSON 前缀也校验 $faultCode", async (invalid) => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-prefix-schema-"));
  const executed: string[] = [];
  try {
    const provider = mock([
      ok({ finish: "tool_calls", parseOk: false, schemaOk: false, faultCode: "arguments_not_json",
        badName: "page.type", toolCalls: [{ id: "bad-prefix", name: invalid.name, arguments: invalid.arguments }] }),
      ok({ finish: "tool_calls", content: "", toolCalls: [
        { id: "finish", name: "finishTurn", arguments: { text: "结束", reason: "完成", affectsPage: false } },
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

test("工具抛错写入记录，清空执行状态并允许下一次模型请求正常收口", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-tool-throw-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("connection reset"); }) as unknown as typeof fetch;
  let requests = 0;
  const provider: Provider = { complete: async ({ messages }) => {
    requests += 1;
    if (requests === 1) return ok({ finish: "tool_calls", toolCalls: [
      { id: "load", name: "catalog.add", arguments: { reason: "测试请求", affectsPage: false, names: ["send_http"] } },
    ] });
    if (requests === 2) return ok({ finish: "tool_calls", toolCalls: [
      { id: "http", name: "send_http", arguments: { reason: "读取", affectsPage: false, url: "https://example.com" } },
      { id: "note", name: "notes.write", arguments: { reason: "继续", affectsPage: false, key: "progress", value: "continued" } },
    ] });
    const ledger = loadLedger(dir, "cv_01");
    expect(ledger.liveTool).toBeNull();
    expect(ledger.toolQueue).toEqual([]);
    expect(ledger.notes.progress).toBe("continued");
    expect(messages[1]!.content).toContain("tool_execution_failed");
    return ok({ finish: "tool_calls", toolCalls: [
      { id: "finish", name: "finishTurn", arguments: { reason: "已处理失败", affectsPage: false, text: "完成" } },
    ] });
  } };
  try {
    const reply = await handleTurn({ dataDir: dir, repoRoot, provider }, { userInput: "执行请求", submittedAt: "now" });
    expect(reply.output).toEqual({ kind: "reply", text: "完成" });
    expect(requests).toBe(3);
    const ledger = loadLedger(dir, reply.conversationId);
    expect(ledger.status).toBe("idle");
    expect(ledger.active).toBeNull();
    expect(ledger.liveTool).toBeNull();
    expect(ledger.toolQueue).toEqual([]);
    const failure = ledger.toolIO.find(row => row.name === "send_http")!;
    expect(JSON.parse(failure.return.text)).toMatchObject({ ok: false, faultCode: "tool_execution_failed", toolName: "send_http" });
    expect(loadEvents(dir, reply.conversationId).some(event => event.kind === "tool" && event.data.callId === failure.callId)).toBe(true);
    expect(loadTurn(dir, reply.conversationId, reply.turnId).status).toBe("completed");
  } finally { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); }
});
