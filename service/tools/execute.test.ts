import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { executeTool, type ExecuteInput } from "./execute.ts";
import { checkToolCalls } from "./schema.ts";
import type { ChatTool } from "../types.ts";

const run = (name: string, args: ExecuteInput["arguments"], content = "") => executeTool({
  name, arguments: args, content, dataDir: "", browserNames: [],
  lookup: { toolIO: [], fullReturn: () => null, observationFull: () => null, unusedTools: [] },
});

test("finishTurn uses explicit text when provider content is empty", async () => {
  expect(await run("finishTurn", { text: "已找到三项结果。" })).toBe("已找到三项结果。");
});

test("askUser uses explicit question and choices when provider content is empty", async () => {
  expect(await run("askUser", { question: "选择哪一项？", choice: ["第一项", "第二项"] }))
    .toBe("选择哪一项？\n选项：第一项 / 第二项");
  expect(await run("askUser", { question: "请输入商品名称。", choice: [] })).toBe("请输入商品名称。");
});

test("explicit closing arguments take precedence over legacy content", async () => {
  expect(await run("finishTurn", { text: " 新回复 " }, "action\n旧回复")).toBe("新回复");
  expect(await run("askUser", { question: "新问题", choice: [] }, "action\n旧问题")).toBe("新问题");
});

test("legacy closing calls retain action fallback", async () => {
  expect(await run("finishTurn", {}, "seen\n页面已读\nreason\n完成\naction\n旧版回复")).toBe("旧版回复");
  expect(await run("askUser", { choice: ["是", "否"] }, "action\n是否继续？")).toBe("是否继续？\n选项：是 / 否");
  expect(await run("finishTurn", { text: "  " }, "action\n兼容回复")).toBe("兼容回复");
  expect(await run("finishTurn", {})).toBe("");
});

test.each([{ name: "finishTurn", field: "text" }, { name: "askUser", field: "question" }])(
  "$name schema requires a nonblank user-facing message", ({ name, field }) => {
    const tool = JSON.parse(readFileSync(new URL(`../../catalog/tools/${name}.json`, import.meta.url), "utf8")) as ChatTool;
    const check = (args: ExecuteInput["arguments"]) => checkToolCalls([
      { id: "closing", name, arguments: { reason: "完成当前步骤", affectsPage: false, choice: [], ...args } },
    ], [tool], [name], []);
    expect(check({}).faultCode).toBe("missing_required");
    for (const value of ["", " \n\t "]) expect(check({ [field]: value }).schemaOk).toBe(false);
    expect(check({ [field]: "有效正文" }).schemaOk).toBe(true);
  },
);
