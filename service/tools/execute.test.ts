import { expect, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool, type ExecuteInput } from "./execute.ts";
import { patchScript } from "../scripts/store.ts";
import { checkToolCalls } from "./schema.ts";
import type { ChatTool } from "../types.ts";

const run = (name: string, args: ExecuteInput["arguments"]) => executeTool({
  name, arguments: args, dataDir: "", browserNames: [],
  lookup: { unusedTools: [], knownTools: [], enabledTools: [] },
}).then((result) => result.text);

test("library tool persists and manages the same cross-conversation items as the panel", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "library-tool-"));
  const invoke = async (arguments_: ExecuteInput["arguments"], conversationId = "cv_01") => JSON.parse((await executeTool({
    name: "library", arguments: arguments_, dataDir, conversationId, browserNames: [],
    lookup: { unusedTools: [], knownTools: [], enabledTools: [] },
  })).text);
  try {
    const created = await invoke({ action: "save", type: "account", title: "测试站点", username: "demo", password: "plain-password", tags: ["常用"] });
    expect(created.ok).toBe(true);
    const id = created.item.id;
    expect((await invoke({ action: "get", id }, "cv_02")).item.password).toBe("plain-password");
    expect((await invoke({ action: "save", id, content: "新备注" })).item.username).toBe("demo");
    expect((await invoke({ action: "list", query: "常用" })).items).toHaveLength(1);
    expect((await invoke({ action: "delete", id })).ok).toBe(true);
    expect((await invoke({ action: "get", id })).ok).toBe(false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("closing tools use their explicit message arguments", async () => {
  expect(await run("finishTurn", { text: " 新回复 " })).toBe("新回复");
  expect(await run("askUser", { question: " 新问题 ", choice: ["是", "否"] })).toBe("新问题\n选项：是 / 否");
});

test.each([undefined, "", "  ", 42, null])("invalid closing text %j cannot end or pause a turn", async (value) => {
  for (const [name, field] of [["finishTurn", "text"], ["askUser", "question"]] as const) {
    const args = name === "finishTurn" ? { text: value } : { question: value, choice: ["是", "否"] };
    const execution = await executeTool({
      name, arguments: args, dataDir: "", browserNames: [],
      lookup: { unusedTools: [], knownTools: [], enabledTools: [] },
    });
    expect(execution.text).toContain(name === "finishTurn" ? "finishTurn 的回复为空" : "askUser 的问题为空");
    expect(execution.effects).toEqual([{ type: "queue.clear" }]);
  }
});

test("finishTurn schema requires nonblank text", () => {
  const tool = JSON.parse(readFileSync(new URL(`./definitions/finishTurn.json`, import.meta.url), "utf8")) as ChatTool;
  const check = (args: ExecuteInput["arguments"]) => checkToolCalls([
    { id: "closing", name: "finishTurn", arguments: { reason: "完成当前步骤", ...args } },
  ], [tool], ["finishTurn"], []);
  expect(check({}).faultCode).toBe("missing_required");
  expect(check({ text: "有效正文" }).schemaOk).toBe(true);
  for (const value of ["", " \n\t "]) {
    expect(check({ text: value }).schemaOk).toBe(false);
  }
});

test("askUser schema requires a nonblank user-facing message", () => {
  const tool = JSON.parse(readFileSync(new URL(`./definitions/askUser.json`, import.meta.url), "utf8")) as ChatTool;
  const check = (args: ExecuteInput["arguments"]) => checkToolCalls([
    { id: "closing", name: "askUser", arguments: { reason: "完成当前步骤", choice: [], ...args } },
  ], [tool], ["askUser"], []);
  expect(check({}).faultCode).toBe("missing_required");
  for (const value of ["", " \n\t "]) expect(check({ question: value }).schemaOk).toBe(false);
  expect(check({ question: "有效正文" }).schemaOk).toBe(true);
});

test("JavaScript values with a target tabId are recorded as page observations", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "script-execute-"));
  try {
    expect((await patchScript(dataDir, { filename: "value.js", patch: "--- /dev/null\n+++ b/value.js\n@@ -0,0 +1 @@\n+1 + 1\n" })).ok).toBe(true);
    const execution = await executeTool({
      name: "execute_javascript", arguments: { filename: "value.js", tabId: 7 }, dataDir,
      browserNames: ["execute_javascript"], host: { execute: async (_name, args) => {
        expect(args).toEqual({ code: "1 + 1\n", tabId: 7 });
        return { ok: true, tabId: 7, type: "number", value: 2 };
      } },
      lookup: { unusedTools: [], knownTools: [], enabledTools: [] },
    });
    expect(JSON.parse(execution.text)).toMatchObject({ ok: true, value: 2 });
    expect(execution.effects).toEqual([{
      type: "page.set",
      page: { tabId: 7, url: "", title: "", description: "当前页面信息" },
      result: { ok: true, tabId: 7, type: "number", value: 2 },
    }]);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("agent_query reuses the Query Agent and emits query.set", async () => {
  const records = [{ id: "call_01", turnId: "tn_01", name: "local_run" }];
  const queryContext = async () => ({
    ok: true as const,
    status: "complete" as const,
    sumId: "sum_01",
    module: "toolIO" as const,
    intent: "核对历史调用参数",
    records,
  });
  const execution = await executeTool({
    name: "agent_query",
    arguments: { reason: "核对历史", sumId: "sum_01", module: "toolIO", intent: "核对历史调用参数" },
    dataDir: "",
    browserNames: [],
    queryContext,
    lookup: { unusedTools: [], knownTools: [], enabledTools: [] },
  });
  const payload = JSON.parse(execution.text);
  expect(payload.ok).toBe(true);
  expect(payload.status).toBe("complete");
  expect(execution.effects).toEqual([{ type: "query.set", query: {
    sumId: "sum_01", module: "toolIO", intent: "核对历史调用参数", status: "complete",
    records, detail: undefined,
  } }]);
});

test("agent_query passes file through to the Query Agent and echoes it", async () => {
  const seen: unknown[] = [];
  const records = [{ id: "ws01", turnId: "tn_01", files: ["src/auth.ts"] }];
  const execution = await executeTool({
    name: "agent_query",
    arguments: { reason: "查鉴权结论", sumId: "sum_01", module: "workspace", intent: "鉴权结论", file: "auth.ts" },
    dataDir: "",
    browserNames: [],
    queryContext: async (args) => {
      seen.push(args);
      return { ok: true as const, status: "complete" as const, sumId: "sum_01", module: "workspace" as const, intent: "鉴权结论", file: "auth.ts", records };
    },
    lookup: { unusedTools: [], knownTools: [], enabledTools: [] },
  });
  expect(seen).toEqual([{ sumId: "sum_01", module: "workspace", intent: "鉴权结论", file: "auth.ts" }]);
  expect(JSON.parse(execution.text)).toMatchObject({ ok: true, status: "complete", file: "auth.ts" });
});



test("agent_compress invokes the Compression Agent with the selected phase", async () => {
  const calls: Array<{ phase: "history" | "current" }> = [];
  const execution = await executeTool({
    name: "agent_compress",
    arguments: { reason: "长任务主动降低历史上下文", phase: "current" },
    dataDir: "",
    browserNames: [],
    compressContext: async args => {
      calls.push(args);
      return { status: "completed", committedTurnIds: ["tn_01"], totalTurns: 1 };
    },
    lookup: { unusedTools: [], knownTools: [], enabledTools: [] },
  });
  expect(calls).toEqual([{ phase: "current" }]);
  expect(JSON.parse(execution.text)).toEqual({
    ok: true,
    status: "completed",
    committedTurnIds: ["tn_01"],
    totalTurns: 1,
  });
});

test("agent_compress passes through the measured windowChars before and after", async () => {
  const execution = await executeTool({
    name: "agent_compress",
    arguments: { reason: "确认压缩前后窗口变化可见" },
    dataDir: "",
    browserNames: [],
    compressContext: async () => ({
      status: "completed",
      committedTurnIds: ["tn_01"],
      totalTurns: 1,
      windowChars: { before: 182000, after: 96000 },
    }),
    lookup: { unusedTools: [], knownTools: [], enabledTools: [] },
  });
  expect(JSON.parse(execution.text).windowChars).toEqual({ before: 182000, after: 96000 });
});

test("agent_compress reports unavailable runtime support", async () => {
  const execution = await executeTool({
    name: "agent_compress",
    arguments: { reason: "验证降级" },
    dataDir: "",
    browserNames: [],
    lookup: { unusedTools: [], knownTools: [], enabledTools: [] },
  });
  const payload = JSON.parse(execution.text);
  expect(payload.ok).toBe(false);
  expect(payload.faultCode).toBe("compress_failed");
});
