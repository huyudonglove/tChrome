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
    const execution = await executeTool({
      name, arguments: { [field]: value, choice: ["是", "否"] }, dataDir: "", browserNames: [],
      lookup: { unusedTools: [], knownTools: [], enabledTools: [] },
    });
    expect(execution.text).toContain(name === "finishTurn" ? "finishTurn 的回复为空" : "askUser 的问题为空");
    expect(execution.effects).toEqual([{ type: "queue.clear" }]);
  }
});

test.each([{ name: "finishTurn", field: "text" }, { name: "askUser", field: "question" }])(
  "$name schema requires a nonblank user-facing message", ({ name, field }) => {
    const tool = JSON.parse(readFileSync(new URL(`./definitions/${name}.json`, import.meta.url), "utf8")) as ChatTool;
    const check = (args: ExecuteInput["arguments"]) => checkToolCalls([
      { id: "closing", name, arguments: { reason: "完成当前步骤", affectsPage: false, choice: [], ...args } },
    ], [tool], [name], []);
    expect(check({}).faultCode).toBe("missing_required");
    for (const value of ["", " \n\t "]) expect(check({ [field]: value }).schemaOk).toBe(false);
    expect(check({ [field]: "有效正文" }).schemaOk).toBe(true);
  },
);

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
