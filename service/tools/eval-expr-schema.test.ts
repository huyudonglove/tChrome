import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadToolRegistry, toolSchemas, dynamicToolIds } from "./registry.ts";
import { checkToolCalls } from "./schema.ts";

const registry = loadToolRegistry(join(import.meta.dir, "../.."));

test("page.eval_expr is a dynamic browser tool with schema-valid args", () => {
  expect(registry.index.browser).toContain("page.eval_expr");
  expect(dynamicToolIds(registry)).toContain("page.eval_expr");
  expect(registry.toolGroups.baseToolsIds).not.toContain("page.eval_expr");
  expect(registry.execution["page.eval_expr"]).toBe("serial");

  const tools = toolSchemas(registry, ["page.eval_expr"]);
  expect(checkToolCalls([
    { id: "c1", name: "page.eval_expr", arguments: { reason: "读标题", tabId: 12, expr: "document.title" } },
    { id: "c2", name: "page.eval_expr", arguments: { reason: "读尺寸", tabId: 12, expr: "(() => ({ w: innerWidth }))()" } },
  ], tools, [], ["page.eval_expr"]).schemaOk).toBe(true);

  expect(checkToolCalls([
    { id: "c3", name: "page.eval_expr", arguments: { reason: "缺 expr", tabId: 12 } },
  ], tools, [], ["page.eval_expr"]).schemaOk).toBe(false);
  expect(checkToolCalls([
    { id: "c4", name: "page.eval_expr", arguments: { reason: "缺 tabId", expr: "1" } },
  ], tools, [], ["page.eval_expr"]).schemaOk).toBe(false);
});

test("page.eval_expr has complete capability metadata", () => {
  const record = registry.capabilities.find((row) => row.id === "page.eval_expr");
  expect(record).toMatchObject({
    kind: "tool",
    availability: "browser",
    risk: "low",
    metadataComplete: true,
  });
  expect(record!.purpose).toContain("免脚本落盘");
  expect(record!.alternatives).toContain("script_write + execute_javascript");
});
