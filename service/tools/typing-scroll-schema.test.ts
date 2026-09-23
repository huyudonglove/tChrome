import { expect, test } from "bun:test";
import { loadToolRegistry, toolSchemas } from "./registry.ts";
import { checkToolCalls } from "./schema.ts";

const root = "/Users/huyudong/Projects/tChrome";
const registry = loadToolRegistry(root);

test("page.type accepts clearBeforeType and pressEnter", () => {
  const tools = toolSchemas(registry, ["page.type"]);
  const ok = checkToolCalls([{
    id: "c1",
    name: "page.type",
    arguments: {
      reason: "搜索",
      tabId: 12,
      id: "e_01",
      text: "casing",
      clearBeforeType: true,
      pressEnter: true,
    },
  }], tools, [], ["page.type"]);
  expect(ok.schemaOk).toBe(true);
});

test("scroll_to wait and press accept optional page element id", () => {
  const names = ["scroll_to", "wait", "press"] as const;
  const tools = toolSchemas(registry, [...names]);
  const ok = checkToolCalls([
    { id: "c1", name: "scroll_to", arguments: { reason: "滚到上传区", tabId: 1, id: "e_05" } },
    { id: "c2", name: "wait", arguments: { reason: "等元素", tabId: 1, id: "e_05", ms: 2000 } },
    { id: "c3", name: "press", arguments: { reason: "回车", tabId: 1, key: "Enter", id: "e_05" } },
  ], tools, [], [...names]);
  expect(ok.schemaOk).toBe(true);
});
