import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { loadToolRegistry, toolSchemas, coreToolIds, dynamicToolIds, zeroCallToolNote } from "./registry.ts";
import { LOCAL_TOOL_NAMES } from "./local-tools.ts";
import { SERVICE_TOOL_NAMES } from "./service-tools.ts";
import { COMPOUND_TOOL_NAMES } from "./compound-tools.ts";
import { JOB_TOOL_NAMES } from "./job-registry.ts";
import { IMAGE_TOOL_NAMES } from "./image-crop.ts";
import { STREAM_TOOL_NAMES } from "./stream-tools.ts";
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
    const risk = registry.capabilities.find((row) => row.kind === "tool" && row.id === name)?.risk;
    // reason 必填性按 risk 分档：low 档免填，medium/high 必填。
    if (risk === "low") expect(params.required ?? [], `${name} low requires no reason`).not.toContain("reason");
    else if (risk && risk !== "unknown") expect(params.required ?? [], `${name} required`).toContain("reason");
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

test("调度说明由 execution 字段派生：定义文件不得再手抄", () => {
  const dir = join(repoRoot, "service", "tools", "definitions");
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json") || ["index.json", "groups.json"].includes(file)) continue;
    expect(readFileSync(join(dir, file), "utf8"), `${file} 手抄调度说明`).not.toContain("执行调度");
  }
});

test("风险档说明由 capabilities 的 risk 派生：定义文件不得再手抄", () => {
  const dir = join(repoRoot, "service", "tools", "definitions");
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json") || ["index.json", "groups.json"].includes(file)) continue;
    expect(readFileSync(join(dir, file), "utf8"), `${file} 手抄风险档`).not.toContain("本工具为");
  }
  const registry = loadToolRegistry(repoRoot);
  const names = [...new Set([...registry.index.browser, ...registry.index.service, ...registry.toolGroups.baseToolsIds])];
  for (const name of names) {
    const risk = registry.capabilities.find((row) => row.kind === "tool" && row.id === name)?.risk;
    if (!risk || risk === "unknown") continue;
    const description = (registry.tools[name]?.function.parameters as {
      properties?: Record<string, { description?: unknown }>;
    })?.properties?.reason?.description;
    if (typeof description !== "string") continue;
    const clause = risk === "low" ? "本工具为 low 档，可省略。" : `本工具为 ${risk} 档，必填。`;
    expect(description, `${name} risk clause`).toContain(clause);
  }
});

test("缺字段和类型错走 Ajv，不补齐", () => {
  const registry = loadToolRegistry(repoRoot);
  const ids = ["page_type", "finishTurn"];
  const tools = toolSchemas(registry, ids);
  const parsed = parseToolArguments('{"id":"e1","text":"a@b.com"}');
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const missing = checkToolCalls(
    [{ id: "call_01", name: "page_type", arguments: parsed.value }],
    tools,
    registry.toolGroups.baseToolsIds,
    ids,
  );
  expect(missing).toEqual({
    parseOk: true,
    schemaOk: false,
    faultCode: "missing_required",
    missing: expect.arrayContaining(["reason"]),
    badName: "page_type",
    detail: "page_type missing required: reason, tabId",
  });
  const wrong = checkToolCalls(
    [{ id: "call_02", name: "page_type", arguments: { tabId: 1, reason: "填", id: "e1", text: 12 as unknown as string } }],
    tools,
    registry.toolGroups.baseToolsIds,
    ids,
  );
  expect(wrong.faultCode).toBe("wrong_type");
  expect(wrong.schemaOk).toBe(false);
});

test("catalog_add drops model-submitted execution; schedule stays Runtime-owned", () => {
  const registry = loadToolRegistry(repoRoot);
  const tools = toolSchemas(registry, ["catalog_add"]);
  const call = { id: "load-script", name: "catalog_add", arguments: { names: ["execute_javascript"], reason: "加载脚本工具", execution: "parallel" } as Record<string, unknown> };
  expect(checkToolCalls([call], tools, [], ["catalog_add"]).schemaOk).toBe(true);
  expect(call.arguments.execution).toBeUndefined();
  expect(checkToolCalls([{ id: "x", name: "catalog_add", arguments: {} }], tools, [], ["catalog_add"]).schemaOk).toBe(false);
});

test("tool calls normalize explicit boolean and numeric strings before execution", () => {
  const registry = loadToolRegistry(repoRoot);
  const ids = ["catalog_add", "page_type"];
  const calls: ToolCall[] = JSON.parse(JSON.stringify([
    { id: "call_01", name: "catalog_add", arguments: { reason: "加载", names: ["execute_javascript"]} },
    { id: "call_02", name: "page_type", arguments: { reason: "填写", tabId: "1502828910", id: "e1", text: "false" } },
  ]));
  expect(checkToolCalls(calls, toolSchemas(registry, ids), [], ids).schemaOk).toBe(true);
  expect(calls[1]!.arguments).toEqual({ reason: "填写", tabId: 1502828910, id: "e1", text: "false" });
});

test("normalization preserves schema constraints and rejects ambiguous values", () => {
  const registry = loadToolRegistry(repoRoot);
  const check = (name: string, args: Record<string, unknown>) => checkToolCalls(
    [{ id: "call_01", name, arguments: args }], toolSchemas(registry, [name]), [], [name],
  ).schemaOk;
  expect(check("catalog_add", { reason: "加载", names: "execute_javascript"})).toBe(false);
  for (const tabId of ["", " ", "0x10", "12px", "Infinity", "1e999", "9007199254740993"]) {
    expect(check("page_type", { reason: "填写", tabId, id: "e1", text: "12" })).toBe(false);
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

test("mode-specific capture tools expose only their own parameters", () => {
  const registry = loadToolRegistry(repoRoot);
  const names = ["capture_viewport", "capture_full_page", "capture_element", "capture_rect", "capture_som"] as const;
  const tools = toolSchemas(registry, [...names]);
  const check = (name: typeof names[number], arguments_: Record<string, unknown> = {}) => checkToolCalls(
    [{id: "capture", name, arguments: {tabId: 1, reason: "观察", ...arguments_}}], tools, [], [...names],
  ).schemaOk;
  expect(check("capture_viewport")).toBe(true);
  expect(check("capture_viewport", {mode: "viewport"})).toBe(false);
  expect(check("capture_full_page")).toBe(true);
  expect(check("capture_full_page", {mode: "full_page"})).toBe(false);
  expect(check("capture_element", {ref: "e_01"})).toBe(true);
  expect(check("capture_element", {selector: "#target"})).toBe(true);
  expect(check("capture_element", {ref: "e_01", selector: "#target"})).toBe(false);
  expect(check("capture_element")).toBe(false);
  expect(check("capture_rect", {x: 1, y: 2, width: 3, height: 4})).toBe(true);
  expect(check("capture_rect", {x: 1, y: 2, width: 0, height: 4})).toBe(false);
  expect(check("capture_rect", {x: 1, y: 2})).toBe(false);
  expect(check("capture_som")).toBe(true);
  expect(check("capture_som", {maxMarks: 20, roles: ["button"]})).toBe(true);
  expect(check("capture_som", {maxMarks: 100})).toBe(false);
  expect(check("capture_som", {mode: "som"})).toBe(false);
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

// 归组守卫：index.json / groups.json 暴露的每个工具名，都必须能被 execute.ts 的某条分派路径命中。
// 判定标准不是「名字登记在哪」，而是「executeTool 会不会走到某个分支」——名单常量、显式 name=== 分支、
// 或 idx.browser 兜底三选一。登记在 service 数组却没有分支的，会在分派末尾落到 tool_unwired（unknown_tool）。
test("index.json 登记的每个工具都能被 execute.ts 的分派路径命中", () => {
  const registry = loadToolRegistry(repoRoot);
  const source = readFileSync(join(repoRoot, "service/tools/execute.ts"), "utf8");
  const explicit = new Set([...source.matchAll(/name\s*===\s*"([^"]+)"/g)].map((row) => row[1]!));
  const lists = [LOCAL_TOOL_NAMES, SERVICE_TOOL_NAMES, COMPOUND_TOOL_NAMES, JOB_TOOL_NAMES, IMAGE_TOOL_NAMES, STREAM_TOOL_NAMES];
  // 注意：这里不把 idx.service 当作有效分支。落进 service 数组但没接线的名字正是要拦的缺陷。
  const branchOf = (name: string) => {
    if (explicit.has(name)) return "explicit";
    if (lists.some((list) => (list as readonly string[]).includes(name))) return "list";
    if (registry.index.browser.includes(name)) return "browser";
    return "unwired";
  };
  const exposed = [...new Set([
    ...registry.index.browser,
    ...registry.index.service,
    ...registry.toolGroups.baseToolsIds,
    ...registry.toolGroups.coreToolIds,
  ])];
  expect(exposed.length).toBeGreaterThan(20);
  expect(exposed.filter((name) => branchOf(name) === "unwired")).toEqual([]);
});

test("service 数组不含已由浏览器通道实现的工具名", () => {
  const registry = loadToolRegistry(repoRoot);
  // page_get_by_role / wait_response 曾误登记在 service 数组，实际实现方是 extension/tools/browser-tools.js。
  const extensionSource = readFileSync(join(repoRoot, "extension/tools/browser-tools.js"), "utf8");
  const implemented = new Set(
    [...extensionSource.matchAll(/['"]([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*)['"]/g)].map((row) => row[1]!),
  );
  const misplaced = registry.index.service.filter((name) => implemented.has(name) && !registry.index.browser.includes(name));
  expect(misplaced).toEqual([]);
});

test("zeroCallToolNote 只列本会话零调用的已加载动态工具", () => {
  const registry = loadToolRegistry(repoRoot);
  const dynamic = dynamicToolIds(registry).slice(0, 2);
  const core = coreToolIds(registry).slice(0, 2);
  expect(dynamic.length).toBe(2);
  const loaded = [...dynamic, ...core];

  // 全被调用过、或根本没加载任何工具时都不出提示。
  expect(zeroCallToolNote(registry, loaded, dynamic.map((name) => ({ name })))).toBe("");
  expect(zeroCallToolNote(registry, [], [])).toBe("");

  // 同名调用重复出现（amend 行）只算「已调用」一次；常驻工具即使零调用也不该出现在清单里。
  const note = zeroCallToolNote(registry, loaded, [{ name: dynamic[0]! }, { name: dynamic[0]! }]);
  expect(note).toBe(`已加载动态工具 2 个，本会话零调用 1 个：${dynamic[1]}。`);
  for (const id of core) expect(note).not.toContain(id);
});
