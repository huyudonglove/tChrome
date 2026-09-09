import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadToolRegistry, toolSchemas } from "./registry.ts";
import { parseToolArguments } from "./arguments.ts";
import { checkToolCalls } from "./schema.ts";

const repoRoot = join(import.meta.dir, "../..");

test("每个工具有 schema 和必填 reason，affectsPage 按工具约定校验", () => {
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
    expect(params.required ?? [], `${name} required`).toContain("reason");
    if (name === "catalog.add") expect(params.required ?? []).not.toContain("affectsPage");
    else expect(params.required ?? [], `${name} required`).toContain("affectsPage");
    expect(tool.function.name).toBe(name);
    expect(registry.tools[name]?.function.description, `${name} usage`).toBeTruthy();
  }
  for (const name of registry.toolGroups.coreToolIds) {
    expect(registry.tools[name], `core ${name}`).toBeTruthy();
  }
});

test("core 工具 schema 带上用法里的必填入参", () => {
  const registry = loadToolRegistry(repoRoot);
  const requiredOf = (name: string) => {
    const params = registry.tools[name]?.function.parameters as { required?: string[] };
    return params.required ?? [];
  };
  expect(requiredOf("page.click")).toContain("id");
  expect(requiredOf("page.type")).toEqual(expect.arrayContaining(["id", "text"]));
  expect(requiredOf("open_url")).toContain("url");
  expect(requiredOf("web_search")).toContain("query");
  expect(requiredOf("submitGoal")).toContain("goal");
  expect(requiredOf("catalog.add")).toContain("names");
  expect(requiredOf("askUser")).toContain("choice");
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
