import { expect, test } from "bun:test";
import { loadToolRegistry, toolSchemas } from "./registry.ts";
import { checkToolCalls } from "./schema.ts";

const root = "/Users/huyudong/Projects/tChrome";
const registry = loadToolRegistry(root);

const cases: [string, Record<string, unknown>][] = [
  ["download", { reason: "下模型", affectsPage: false, url: "https://example.com/a.glb" }],
  ["control_download", { reason: "暂停", affectsPage: false, downloadId: 3, action: "pause" }],
  ["set_cookie", { reason: "登录态", affectsPage: true, name: "sid", value: "x", url: "https://example.com" }],
  ["delete_cookie", { reason: "清会话", affectsPage: true, name: "sid" }],
  ["clear_cookies", { reason: "清站", affectsPage: true, origin: "https://example.com" }],
  ["cookies", { reason: "读 cookie", affectsPage: false, tabId: 1, url: "https://example.com" }],
  ["profile_vault", { reason: "保存档案", affectsPage: false, action: "save", profileId: "p1", data: { a: 1 } }],
  ["cache_storage", { reason: "读缓存", affectsPage: false, tabId: 1, action: "list", cache: "app" }],
  ["indexeddb", { reason: "读库", affectsPage: false, tabId: 1, action: "list", db: "app" }],
  ["page_storage", { reason: "写本地", affectsPage: true, tabId: 1, action: "write", key: "k", value: "v" }],
  ["permission_grant", { reason: "尝试授权", affectsPage: false, permission: "notifications" }],
  ["permission_deny", { reason: "拒绝授权", affectsPage: false, permission: "notifications" }],
  ["network_throttle", { reason: "弱网", affectsPage: true, tabId: 1, profile: "slow-3g" }],
  ["set_zoom", { reason: "放大", affectsPage: true, tabId: 1, zoom: 1.25 }],
  ["see_console", { reason: "看报错", affectsPage: false, tabId: 1, level: "error" }],
  ["emulate_device", { reason: "手机视口", affectsPage: true, tabId: 1, device: "iphone", width: 390, height: 844 }],
  ["export_data", { reason: "导出报告", affectsPage: false, data: { ok: true }, filename: "report.json" }],
];

test("expanded tool schemas accept implementation-facing parameters", () => {
  for (const [name, args] of cases) {
    const tools = toolSchemas(registry, [name]);
    const result = checkToolCalls([{ id: `c_${name}`, name, arguments: args }], tools, [], [name]);
    expect(result.schemaOk, name).toBe(true);
  }
});

test("download still requires url", () => {
  const tools = toolSchemas(registry, ["download"]);
  const result = checkToolCalls([{
    id: "c1",
    name: "download",
    arguments: { reason: "x", affectsPage: false },
  }], tools, [], ["download"]);
  expect(result.schemaOk).toBe(false);
});
