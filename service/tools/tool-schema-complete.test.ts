import { expect, test } from "bun:test";
import { loadToolRegistry, toolSchemas } from "./registry.ts";
import { checkToolCalls } from "./schema.ts";

const root = new URL("../../", import.meta.url).pathname;
const registry = loadToolRegistry(root);

const cases: [string, Record<string, unknown>][] = [
  ["download", { reason: "下模型", url: "https://example.com/a.glb" }],
  ["control_download", { reason: "暂停", downloadId: 3, action: "pause" }],
  ["set_cookie", { reason: "登录态", name: "sid", value: "x", url: "https://example.com" }],
  ["delete_cookie", { reason: "清会话", name: "sid" }],
  ["clear_cookies", { reason: "清站", origin: "https://example.com" }],
  ["cookies", { reason: "读 cookie", tabId: 1, url: "https://example.com" }],
  ["profile_vault", { reason: "保存档案", action: "save", profileId: "p1", data: { a: 1 } }],
  ["cache_storage", { reason: "读缓存", tabId: 1, action: "list", cache: "app" }],
  ["indexeddb", { reason: "读库", tabId: 1, action: "list", db: "app" }],
  ["page_storage", { reason: "写本地", tabId: 1, action: "write", key: "k", value: "v" }],
  ["network_throttle", { reason: "弱网", tabId: 1, profile: "slow-3g" }],
  ["set_zoom", { reason: "放大", tabId: 1, zoom: 1.25 }],
  ["see_console", { reason: "看报错", tabId: 1, level: "error" }],
  ["emulate_device", { reason: "手机视口", tabId: 1, device: "iphone", width: 390, height: 844 }],
  ["export_data", { reason: "导出报告", data: { ok: true }, filename: "report.json" }],
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
    arguments: { reason: "x" },
  }], tools, [], ["download"]);
  expect(result.schemaOk).toBe(false);
});

test("all tool definition properties must declare explicit valid type", () => {
  const issues: string[] = [];

  function validateProperties(props: Record<string, any> | undefined, toolName: string, prefix = "") {
    if (!props || typeof props !== "object") return;
    for (const [key, prop] of Object.entries(props)) {
      const fullPath = prefix ? `${prefix}.${key}` : key;
      if (!prop || typeof prop !== "object") continue;
      if (!prop.type && !prop.$ref && !prop.anyOf && !prop.oneOf) {
        issues.push(`Tool '${toolName}' property '${fullPath}' is missing 'type' declaration`);
      }
      if (prop.properties) {
        validateProperties(prop.properties, toolName, fullPath);
      }
      if (prop.items && prop.items.properties) {
        validateProperties(prop.items.properties, toolName, `${fullPath}[]`);
      }
    }
  }

  for (const [name, tool] of Object.entries(registry.tools)) {
    const fn = (tool as any).function || tool;
    validateProperties(fn.parameters?.properties, name);
  }

  expect(issues).toEqual([]);
});

// 跨工具复用的重点参数必须有 description，否则模型只能靠猜。
// 刻意不纳入的两项：
//   tabId —— 20 个工具在磁盘 definitions 里没有描述，运行时视图却有，来源未定位；
//            门禁要求它等于把门禁卡在当前无法修复的状态，先等对照实验定位来源。
//   role 的 enum —— 扩展侧 roleOf() 动态归一化、运行时无权威闭合取值表，
//            硬写 enum 会让 schema 失真；只约束 description。
const FOCUS_PARAM_DESC = ["frameId", "id", "role", "timeoutMs"];

function collectProps(schema: any, out: Record<string, any> = {}, depth = 0): Record<string, any> {
  if (!schema || typeof schema !== "object" || depth > 6) return out;
  for (const branch of [schema.allOf, schema.anyOf, schema.oneOf]) {
    if (!Array.isArray(branch)) continue;
    for (const item of branch) collectProps(item, out, depth + 1);
  }
  for (const [key, prop] of Object.entries(schema.properties || {})) {
    if (prop && typeof prop === "object" && out[key] === undefined) out[key] = prop;
  }
  return out;
}

test("shared focus parameters must declare descriptions", () => {
  const issues: string[] = [];
  for (const tool of toolSchemas(registry, Object.keys(registry.tools))) {
    const props = collectProps(tool.function?.parameters);
    for (const key of FOCUS_PARAM_DESC) {
      if (!(key in props)) continue;
      if (!props[key].description) issues.push(`${tool.function.name}.${key} is missing 'description'`);
    }
  }
  expect(issues).toEqual([]);
});

