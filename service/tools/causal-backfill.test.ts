import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadToolRegistry, toolSchemas } from "./registry.ts";
import { checkToolCalls } from "./schema.ts";

const repoRoot = join(import.meta.dir, "../..");
const registry = loadToolRegistry(repoRoot);

const propsOf = (name: string) => {
  const tool = registry.tools[name]!;
  return (tool.function.parameters as { properties: Record<string, unknown> }).properties;
};

test("tools with reason gain optional expected and fallback at registry load", () => {
  for (const name of ["page_type", "page_eval_expr", "task_set", "finishTurn", "drag"]) {
    const props = propsOf(name);
    expect(props.expected, name).toMatchObject({ type: "string" });
    expect(props.fallback, name).toMatchObject({ type: "string" });
    const required = (registry.tools[name]!.function.parameters as { required?: string[] }).required ?? [];
    expect(required, name).not.toContain("expected");
    expect(required, name).not.toContain("fallback");
  }
});

test("causal backfill is accepted by schema validation and stays optional", () => {
  const tools = toolSchemas(registry, ["page_type"]);
  const ok = checkToolCalls(
    [{ id: "c1", name: "page_type", arguments: {
      reason: "填邮箱",
      expected: "输入框值等于目标邮箱",
      fallback: "若被清空则改用 fill_role 重试一次，不盲点提交",
      tabId: 1, id: "e_01", text: "a@b.com",
    } }],
    tools, [], ["page_type"],
  );
  expect(ok.schemaOk).toBe(true);

  const withoutBackfill = checkToolCalls(
    [{ id: "c2", name: "page_type", arguments: { reason: "填邮箱", tabId: 1, id: "e_01", text: "a@b.com" } }],
    tools, [], ["page_type"],
  );
  expect(withoutBackfill.schemaOk).toBe(true);

  const wrongType = checkToolCalls(
    [{ id: "c3", name: "page_type", arguments: { reason: "填", expected: 1, tabId: 1, id: "e_01", text: "x" } }],
    tools, [], ["page_type"],
  );
  expect(wrongType.schemaOk).toBe(false);
});
