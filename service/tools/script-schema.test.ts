import { expect, test } from "bun:test";
import { join } from "node:path";
import { dynamicToolIds, loadToolRegistry, toolSchemas } from "./registry.ts";
import { checkToolCalls } from "./schema.ts";

const registry = loadToolRegistry(join(import.meta.dir, "../.."));
const check = (name: string, args: Record<string, unknown>) => checkToolCalls(
  [{ id: "call_script", name, arguments: { reason: "执行已保存脚本", affectsPage: false, ...args } }],
  toolSchemas(registry, [name]), [], [name],
);

test("script file tools are registered service capabilities with no page effects", () => {
  for (const name of ["script_patch", "script_read", "script_list"]) {
    expect(registry.index.service.filter(id => id === name)).toHaveLength(1);
    expect(dynamicToolIds(registry)).toContain(name);
    const args = name === "script_list" ? {} : { filename: "task.py", ...(name === "script_patch" ? { patch: "diff --git a/task.py b/task.py" } : {}) };
    expect(check(name, args).schemaOk).toBe(true);
    expect(check(name, { ...args, affectsPage: true }).schemaOk).toBe(false);
    expect(check(name, { ...args, command: "echo unsafe" }).schemaOk).toBe(false);
  }
});

test("script file names are single supported files, not paths", () => {
  for (const filename of ["task.sh", "task.py", "task.js", "task.mjs", "task.cjs"]) {
    expect(check("script_read", { filename }).schemaOk).toBe(true);
  }
  for (const filename of ["../task.js", "/task.js", "nested/task.js", ".hidden.js", "task.zsh", "task.txt", ""]) {
    expect(check("script_read", { filename }).schemaOk).toBe(false);
    expect(check("script_patch", { filename, patch: "diff" }).schemaOk).toBe(false);
  }
  expect(check("script_patch", { filename: "task.js", patch: "" }).schemaOk).toBe(false);
});

test("page execution accepts JavaScript filenames and rejects legacy inline code", () => {
  for (const filename of ["task.js", "task.mjs", "task.cjs"]) {
    expect(check("execute_javascript", { filename, tab: 12 }).schemaOk).toBe(true);
  }
  for (const args of [{ code: "1 + 1" }, { filename: "task.js", code: "1 + 1" }, { filename: "task.py" }, { filename: "../task.js" }]) {
    expect(check("execute_javascript", args).schemaOk).toBe(false);
  }
});
