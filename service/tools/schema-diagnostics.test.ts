import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadToolRegistry, toolSchemas } from "./registry.ts";
import { checkToolCalls } from "./schema.ts";

const registry = loadToolRegistry(join(import.meta.dir, "../.."));
const check = (name: string, args: Record<string, unknown>) => checkToolCalls(
  [{ id: "test", name, arguments: args }], toolSchemas(registry, [name]), [], [name],
);

test("target alternatives stay separate from mandatory arguments", () => {
  const result = check("click", { reason: "操作" });
  expect(result.missing).toEqual(["affectsPage"]);
  expect(result.detail).toContain("at least one alternative");
  expect(result.detail).toContain('[{"required":["ref"]},{"required":["targetText"]}]');
  expect(result.detail).not.toContain("missing required: ref, targetText");
  const wrongText = check("click", { reason: "操作", targetText: true });
  expect(wrongText.missing).toEqual(["affectsPage"]);
  expect(wrongText.detail).toContain("data/targetText must be string");
});

test("exclusive and conditional capture targets report the actual rule", () => {
  const base = { reason: "截图", affectsPage: false, mode: "element" };
  const missing = check("capture_page", base);
  expect(missing.missing).toEqual([]);
  expect(missing.detail).toContain("exactly one alternative");
  expect(missing.detail).toContain('[{"required":["ref"]},{"required":["selector"]}]');
  const both = check("capture_page", { ...base, ref: "el-1", selector: "button" });
  expect(both.detail).toContain('exactly one alternative: [{"required":["ref"]},{"required":["selector"]}]');
  const viewport = check("capture_page", { ...base, mode: "viewport", selector: "button" });
  expect(viewport.detail).toContain('must NOT be valid');
  expect(viewport.detail).toContain('"ref"');
  expect(viewport.detail).toContain('"selector"');
});

test("conditional library requirements remain mandatory and retain simultaneous type errors", () => {
  const save = check("library", { action: "save", reason: "保存", affectsPage: false, tags: [3] });
  expect(save.missing).toEqual(["type", "title"]);
  expect(save.detail).toContain("data/tags/0 must be string");
  expect(check("library", { action: "get", reason: "读取", affectsPage: false }).missing).toEqual(["id"]);
});

test("missing discriminators do not activate unrelated conditional requirements", () => {
  expect(check("library", { reason: "保存", affectsPage: false }).missing).toEqual(["action"]);
  const capture = check("capture_page", { reason: "截图", affectsPage: false });
  expect(capture.missing).toEqual(["mode"]);
  expect(capture.detail).not.toContain("alternative");
});
