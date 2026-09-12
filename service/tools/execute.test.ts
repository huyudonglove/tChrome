import { expect, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool, type ExecuteInput } from "./execute.ts";
import { checkToolCalls } from "./schema.ts";
import type { ChatTool } from "../types.ts";

const run = (name: string, args: ExecuteInput["arguments"], content = "") => executeTool({
  name, arguments: args, content, dataDir: "", browserNames: [],
  lookup: { unusedTools: [], knownTools: [], enabledTools: [] },
}).then((result) => result.text);

test("library tool persists and manages the same cross-conversation items as the panel", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "library-tool-"));
  const invoke = async (arguments_: ExecuteInput["arguments"], conversationId = "cv_01") => JSON.parse((await executeTool({
    name: "library", arguments: arguments_, content: "", dataDir, conversationId, browserNames: [],
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

test("explicit closing arguments take precedence over legacy content", async () => {
  expect(await run("finishTurn", { text: " 新回复 " }, "action\n旧回复")).toBe("新回复");
  expect(await run("askUser", { question: "新问题", choice: [] }, "action\n旧问题")).toBe("新问题");
});

test("legacy closing calls retain action fallback", async () => {
  expect(await run("finishTurn", {}, "seen\n页面已读\nreason\n完成\naction\n旧版回复")).toBe("旧版回复");
  expect(await run("askUser", { choice: ["是", "否"] }, "action\n是否继续？")).toBe("是否继续？\n选项：是 / 否");
  expect(await run("finishTurn", { text: "  " }, "action\n兼容回复")).toBe("兼容回复");
  expect(await run("finishTurn", {})).toContain("finishTurn 的回复为空");
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

test("JavaScript values with only a target tab do not overwrite the current page", async () => {
  const execution = await executeTool({
    name: "execute_javascript", arguments: { code: "1 + 1", tab: 7 }, content: "", dataDir: "",
    browserNames: ["execute_javascript"], host: { execute: async () => ({ ok: true, tab: 7, type: "number", value: 2 }) },
    lookup: { unusedTools: [], knownTools: [], enabledTools: [] },
  });
  expect(JSON.parse(execution.text)).toMatchObject({ ok: true, value: 2 });
  expect(execution.effects).toEqual([]);
});
