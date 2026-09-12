import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadToolRegistry, toolSchemas } from "./registry.ts";
import { parseToolArguments } from "./arguments.ts";
import { checkToolCalls } from "./schema.ts";
import type { ToolCall } from "../types.ts";

const repoRoot = join(import.meta.dir, "../..");

test("每个工具有 schema 和 reason，affectsPage 按工具约定校验", () => {
  const registry = loadToolRegistry(repoRoot);
  const listed = [...registry.index.browser, ...registry.index.service, ...registry.toolGroups.baseToolsIds];
  const unique = [...new Set(listed)];
  expect(unique.length).toBeGreaterThan(20);
  for (const name of unique) {
    const tool = registry.tools[name];
    expect(tool, name).toBeTruthy();
    if (!tool) continue;
    const params = tool.function.parameters as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(params.properties?.reason, `${name} reason`).toBeTruthy();
    expect(params.properties?.affectsPage, `${name} affectsPage`).toBeTruthy();
    if (!["click", "page.click"].includes(name)) expect(params.required ?? [], `${name} required`).toContain("reason");
    if (name === "catalog.add") expect(params.required ?? []).not.toContain("affectsPage");
    else expect(params.required ?? [], `${name} required`).toContain("affectsPage");
    expect(tool.function.name).toBe(name);
    expect(registry.tools[name]?.function.description, `${name} usage`).toBeTruthy();
  }
  for (const name of registry.toolGroups.coreToolIds) {
    expect(registry.tools[name], `core ${name}`).toBeTruthy();
  }
});

test("缺字段和类型错走 Ajv，不补齐", () => {
  const registry = loadToolRegistry(repoRoot);
  const ids = ["page.type", "finishTurn"];
  const tools = toolSchemas(registry, ids);
  const parsed = parseToolArguments('{"id":"e1","text":"a@b.com",}');
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const missing = checkToolCalls(
    [{ id: "call_01", name: "page.type", arguments: parsed.value }],
    tools,
    registry.toolGroups.baseToolsIds,
    ids,
  );
  expect(missing).toEqual({
    parseOk: true,
    schemaOk: false,
    faultCode: "missing_required",
    missing: expect.arrayContaining(["reason", "affectsPage"]),
    badName: "page.type",
    detail: "page.type missing required: reason, affectsPage",
  });
  const wrong = checkToolCalls(
    [{ id: "call_02", name: "page.type", arguments: { reason: "填", affectsPage: true, id: "e1", text: 12 as unknown as string } }],
    tools,
    registry.toolGroups.baseToolsIds,
    ids,
  );
  expect(wrong.faultCode).toBe("wrong_type");
  expect(wrong.schemaOk).toBe(false);
});

test("catalog.add accepts the reported names/reason call without affectsPage and rejects true", () => {
  const registry = loadToolRegistry(repoRoot);
  const tools = toolSchemas(registry, ["catalog.add"]);
  const check = (arguments_: Record<string, unknown>) => checkToolCalls([
    { id: "load-script", name: "catalog.add", arguments: arguments_ },
  ], tools, [], ["catalog.add"]);
  const args = { names: ["execute_javascript"], reason: "加载脚本工具" };
  expect(check(args).schemaOk).toBe(true);
  expect(check({ ...args, affectsPage: false }).schemaOk).toBe(true);
  expect(check({ ...args, affectsPage: true }).schemaOk).toBe(false);
  expect(check({ names: args.names }).schemaOk).toBe(false);
});

test("tool calls normalize explicit boolean and numeric strings before execution", () => {
  const registry = loadToolRegistry(repoRoot);
  const ids = ["catalog.add", "page.type"];
  const calls: ToolCall[] = JSON.parse(JSON.stringify([
    { id: "call_01", name: "catalog.add", arguments: { reason: "加载", names: ["execute_javascript"], affectsPage: "false" } },
    { id: "call_02", name: "page.type", arguments: { reason: "填写", affectsPage: "true", tab: "1502828910", id: "e1", text: "false" } },
  ]));
  expect(checkToolCalls(calls, toolSchemas(registry, ids), [], ids).schemaOk).toBe(true);
  expect(calls[0]!.arguments.affectsPage).toBe(false);
  expect(calls[1]!.arguments).toEqual({ reason: "填写", affectsPage: true, tab: 1502828910, id: "e1", text: "false" });
});

test("normalization preserves schema constraints and rejects ambiguous values", () => {
  const registry = loadToolRegistry(repoRoot);
  const check = (name: string, args: Record<string, unknown>) => checkToolCalls(
    [{ id: "call_01", name, arguments: args }], toolSchemas(registry, [name]), [], [name],
  ).schemaOk;
  for (const affectsPage of ["true", "False", "0", "", 0, null]) {
    expect(check("catalog.add", { reason: "加载", names: ["execute_javascript"], affectsPage })).toBe(false);
  }
  expect(check("catalog.add", { reason: "加载", names: "execute_javascript", affectsPage: "false" })).toBe(false);
  for (const tab of ["", " ", "0x10", "12px", "Infinity", "1e999", "9007199254740993"]) {
    expect(check("page.type", { reason: "填写", affectsPage: "true", tab, id: "e1", text: "12" })).toBe(false);
  }
});


test("capture_page validates mode-specific target parameters", () => {
  const registry = loadToolRegistry(repoRoot);
  const tools = toolSchemas(registry, ["capture_page"]);
  const valid = (arguments_: Record<string, unknown>) => checkToolCalls(
    [{id: "capture", name: "capture_page", arguments: {reason: "观察", affectsPage: false, ...arguments_}}], tools, [], ["capture_page"],
  ).schemaOk;
  for (const args of [{mode: "viewport"}, {mode: "full_page"}, {mode: "element", ref: "el-example"}, {mode: "element", selector: "#target"}]) expect(valid(args)).toBe(true);
  for (const args of [{}, {mode: "pdf"}, {mode: "element"}, {mode: "element", ref: "e1"}, {mode: "element", ref: "el-example", selector: "#target"}, {mode: "viewport", selector: "#target"}]) expect(valid(args)).toBe(false);
});

test("send_http requires an HTTP link string and documents all request fields", () => {
  const registry = loadToolRegistry(repoRoot);
  const tools = toolSchemas(registry, ["send_http"]);
  const check = (args: Record<string, unknown>) => checkToolCalls([
    { id: "call_01", name: "send_http", arguments: { reason: "请求", affectsPage: false, ...args } },
  ], tools, [], ["send_http"]);
  expect(check({}).faultCode).toBe("missing_required");
  for (const url of [true, false, 123, "example.com", "/path", "file:///tmp/a", "ftp://example.com", "https://", "https://example.com/a b"]) {
    expect(check({ url }).schemaOk).toBe(false);
  }
  expect(check({ url: "https://example.com/path?q=test", method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).schemaOk).toBe(true);
  expect(check({ url: "http://localhost:8080/" }).schemaOk).toBe(true);
  expect(check({ url: "https://example.com", headers: { x: true } }).schemaOk).toBe(false);
});

test("HTTP requests and batches expose their business fields and reject incomplete calls", () => {
  const registry = loadToolRegistry(repoRoot);
  const check = (name: string, args: Record<string, unknown>) => checkToolCalls([
    { id: "call_01", name, arguments: { reason: "读取", affectsPage: false, ...args } },
  ], toolSchemas(registry, [name]), [], [name]).schemaOk;
  expect(check("send_http", {url:"https://example.com", method:"POST", headers:{x:"value"}, body:"{}"})).toBe(true);
  for (const args of [{}, {url:true}, {url:{address:"https://example.com"}}]) expect(check("send_http",args)).toBe(false);
  expect(check("send_http_batch", {urls:["https://example.com"]})).toBe(true);
  for (const urls of [undefined, [], "https://example.com", [true], Array(6).fill("https://example.com")]) expect(check("send_http_batch", {urls})).toBe(false);
});

test('model tool registry exposes canonical capabilities and rejects retired aliases', () => {
  const registry = loadToolRegistry(repoRoot);
  const retired = ['deep_search', 'search_plus', 'osint_intel', 'web_search_free', 'api_execute', 'api_discover', 'api_manage'];
  for (const name of retired) {
    expect(registry.index.service).not.toContain(name);
    expect(registry.tools[name]).toBeUndefined();
    expect(() => toolSchemas(registry, [name])).toThrow(`unknown tool ${name}`);
  }
  expect(toolSchemas(registry, ['web_search', 'send_http']).map(t => t.function.name)).toEqual(['web_search', 'send_http']);
});
