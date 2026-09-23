import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadToolRegistry, toolSchemas } from "./registry.ts";
import { parseToolArguments } from "./arguments.ts";
import { checkToolCalls } from "./schema.ts";
import type { ToolCall } from "../types.ts";

const repoRoot = join(import.meta.dir, "../..");

test("每个工具有 schema 和 reason，execution 可选且不进 required", () => {
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
    expect(params.properties?.execution, `${name} execution not a model param`).toBeUndefined();
    expect(registry.execution[name] === "parallel" || registry.execution[name] === "serial", `${name} default`).toBe(true);
    expect(String(tool.function.description), `${name} schedule note`).toContain("执行调度");
    if (!["click", "page.click", "finishTurn"].includes(name)) expect(params.required ?? [], `${name} required`).toContain("reason");
    expect(params.required ?? [], `${name} required`).not.toContain("execution");
    if (name === "finishTurn") {
      expect(params.required ?? [], "finishTurn required").toEqual(expect.arrayContaining(["text"]));
      expect(params.required ?? [], "finishTurn required").not.toContain("summary");
    }
    const checkBranches = (schema: any) => {
      if (schema.required) {
        expect(schema.type, `${name} required schema type`).toBe("object");
        for (const key of schema.required) expect(schema.properties?.[key], `${name} required ${key}`).toBeDefined();
      }
      for (const key of ["anyOf", "oneOf", "allOf"]) for (const branch of schema[key] ?? []) checkBranches(branch);
      for (const key of ["if", "then", "else", "not"]) if (schema[key]) checkBranches(schema[key]);
    };
    checkBranches(params);
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
  const parsed = parseToolArguments('{"id":"e1","text":"a@b.com"}');
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
    missing: expect.arrayContaining(["reason"]),
    badName: "page.type",
    detail: "page.type missing required: reason, tabId",
  });
  const wrong = checkToolCalls(
    [{ id: "call_02", name: "page.type", arguments: { tabId: 1, reason: "填", id: "e1", text: 12 as unknown as string } }],
    tools,
    registry.toolGroups.baseToolsIds,
    ids,
  );
  expect(wrong.faultCode).toBe("wrong_type");
  expect(wrong.schemaOk).toBe(false);
});

test("catalog.add drops model-submitted execution; schedule stays Runtime-owned", () => {
  const registry = loadToolRegistry(repoRoot);
  const tools = toolSchemas(registry, ["catalog.add"]);
  const call = { id: "load-script", name: "catalog.add", arguments: { names: ["execute_javascript"], reason: "加载脚本工具", execution: "parallel" } as Record<string, unknown> };
  expect(checkToolCalls([call], tools, [], ["catalog.add"]).schemaOk).toBe(true);
  expect(call.arguments.execution).toBeUndefined();
  expect(checkToolCalls([{ id: "x", name: "catalog.add", arguments: { names: ["execute_javascript"] } }], tools, [], ["catalog.add"]).schemaOk).toBe(false);
});

test("tool calls normalize explicit boolean and numeric strings before execution", () => {
  const registry = loadToolRegistry(repoRoot);
  const ids = ["catalog.add", "page.type"];
  const calls: ToolCall[] = JSON.parse(JSON.stringify([
    { id: "call_01", name: "catalog.add", arguments: { reason: "加载", names: ["execute_javascript"]} },
    { id: "call_02", name: "page.type", arguments: { reason: "填写", tabId: "1502828910", id: "e1", text: "false" } },
  ]));
  expect(checkToolCalls(calls, toolSchemas(registry, ids), [], ids).schemaOk).toBe(true);
  expect(calls[1]!.arguments).toEqual({ reason: "填写", tabId: 1502828910, id: "e1", text: "false" });
});

test("normalization preserves schema constraints and rejects ambiguous values", () => {
  const registry = loadToolRegistry(repoRoot);
  const check = (name: string, args: Record<string, unknown>) => checkToolCalls(
    [{ id: "call_01", name, arguments: args }], toolSchemas(registry, [name]), [], [name],
  ).schemaOk;
  expect(check("catalog.add", { reason: "加载", names: "execute_javascript"})).toBe(false);
  for (const tabId of ["", " ", "0x10", "12px", "Infinity", "1e999", "9007199254740993"]) {
    expect(check("page.type", { reason: "填写", tabId, id: "e1", text: "12" })).toBe(false);
  }
});


test("capture_page validates mode-specific target parameters", () => {
  const registry = loadToolRegistry(repoRoot);
  const tools = toolSchemas(registry, ["capture_page"]);
  const valid = (arguments_: Record<string, unknown>) => checkToolCalls(
    [{id: "capture", name: "capture_page", arguments: {tabId: 1, reason: "观察", ...arguments_}}], tools, [], ["capture_page"],
  ).schemaOk;
  for (const args of [{mode: "viewport"}, {mode: "full_page"}, {mode: "element", ref: "e_01"}, {mode: "element", selector: "#target"}, {mode: "som"}, {mode: "som", maxMarks: 20, roles: ["button"]}]) expect(valid(args)).toBe(true);
  for (const args of [{}, {mode: "pdf"}, {mode: "element"}, {mode: "element", ref: "e1"}, {mode: "element", ref: "e_01", selector: "#target"}, {mode: "viewport", selector: "#target"}, {mode: "som", ref: "e_01"}]) expect(valid(args)).toBe(false);
});

test("send_http requires an HTTP link string and documents all request fields", () => {
  const registry = loadToolRegistry(repoRoot);
  const tools = toolSchemas(registry, ["send_http"]);
  const check = (args: Record<string, unknown>) => checkToolCalls([
    { id: "call_01", name: "send_http", arguments: { reason: "请求", ...args } },
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
    { id: "call_01", name, arguments: { reason: "读取", ...args } },
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
