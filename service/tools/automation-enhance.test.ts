import { expect, test } from "bun:test";
import { loadToolRegistry, toolSchemas } from "./registry.ts";
import { checkToolCalls } from "./schema.ts";

const root = "/Users/huyudong/Projects/tChrome";
const registry = loadToolRegistry(root);

test("new automation tools are registered and accept documented arguments", () => {
  expect(registry.toolGroups.coreToolIds).toContain("page.get_by_role");
  expect(registry.toolGroups.coreToolIds).toContain("wait_response");
  const names = ["wait", "wait_response", "page.get_by_role", "capture_network_traffic"] as const;
  const tools = toolSchemas(registry, [...names]);
  const result = checkToolCalls([
    { id: "c1", name: "wait", arguments: { reason: "等按钮", affectsPage: false, tabId: 12, id: "e_05", visible: true, enabled: true } },
    { id: "c2", name: "wait", arguments: { reason: "等选择器", affectsPage: false, tabId: 12, selector: "input[type=file]" } },
    { id: "c3", name: "wait_response", arguments: { reason: "等接口", affectsPage: false, tabId: 12, urlContains: "/api/upload", status: 200 } },
    { id: "c4", name: "page.get_by_role", arguments: { reason: "找按钮", affectsPage: false, tabId: 12, role: "button", name: "上传" } },
    { id: "c5", name: "capture_network_traffic", arguments: { reason: "过滤资源", affectsPage: false, tabId: 12, urlContains: "/static/" } },
  ], tools, registry.toolGroups.coreToolIds, [...names]);
  expect(result.schemaOk).toBe(true);
});

test("wait_response requires urlContains", () => {
  const tools = toolSchemas(registry, ["wait_response"]);
  const result = checkToolCalls([{
    id: "c1",
    name: "wait_response",
    arguments: { reason: "x", affectsPage: false, tabId: 1 },
  }], tools, [], ["wait_response"]);
  expect(result.schemaOk).toBe(false);
});
