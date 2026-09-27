import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadToolRegistry, toolSchemas } from "./registry.ts";
import { checkToolCalls } from "./schema.ts";

const registry = loadToolRegistry(join(import.meta.dir, "../.."));
const check = (name: string, args: Record<string, unknown>) => checkToolCalls(
  [{ id: "test", name, arguments: { ...(name !== "library" ? {tabId: 1} : {}), ...args } }], toolSchemas(registry, [name]), [], [name],
);

test("target alternatives stay separate from mandatory arguments", () => {
  const result = check("click", { reason: "操作" });
  expect(result.missing).toEqual([]);
  expect(result.faultCode).toBe("wrong_type");
  expect(result.detail).toContain("at least one alternative");
  expect(result.detail).toContain('"required":["ref"]');
  expect(result.detail).toContain('"required":["targetText"]');
  expect(result.detail).not.toContain("missing required: ref, targetText");
  const wrongText = check("click", { reason: "操作", targetText: true });
  expect(wrongText.missing).toEqual([]);
  expect(wrongText.detail).toContain("data/targetText must be string");
});

test("exclusive and conditional capture targets report the actual rule", () => {
  const base = { reason: "截图", mode: "element" };
  const missing = check("capture_page", base);
  expect(missing.missing).toEqual([]);
  expect(missing.detail).toContain("exactly one alternative");
  expect(missing.detail).toContain('"required":["ref"]');
  expect(missing.detail).toContain('"required":["selector"]');
  const both = check("capture_page", { ...base, ref: "e_01", selector: "button" });
  expect(both.detail).toContain('exactly one alternative');
  const viewport = check("capture_page", { ...base, mode: "viewport", selector: "button" });
  expect(viewport.detail).toContain('must NOT be valid');
  expect(viewport.detail).toContain('"ref"');
  expect(viewport.detail).toContain('"selector"');
});

test("conditional library requirements remain mandatory and retain simultaneous type errors", () => {
  const save = check("library", { action: "save", reason: "保存", tags: [3] });
  expect(save.missing).toEqual(["type", "title"]);
  expect(save.detail).toContain("data/tags/0 must be string");
  expect(check("library", { action: "get", reason: "读取" }).missing).toEqual(["id"]);
});

test("missing discriminators do not activate unrelated conditional requirements", () => {
  expect(check("library", { reason: "保存" }).missing).toEqual(["action"]);
  const capture = check("capture_page", { reason: "截图" });
  expect(capture.missing).toEqual(["mode"]);
  expect(capture.detail).not.toContain("alternative");
});

test("empty optional arguments are omitted while required empties remain invalid", () => {
  const reflection = checkToolCalls(
    [{ id: "test", name: "reflect.write", arguments: { reason: "记录", text: "结论", focus: "", id: "" } }],
    toolSchemas(registry, ["reflect.write"]), [], ["reflect.write"],
  );
  expect(reflection.schemaOk).toBe(true);
  expect(reflection.missing).toEqual([]);

  const required = checkToolCalls(
    [{ id: "test", name: "reflect.write", arguments: { reason: "记录", text: "" } }],
    toolSchemas(registry, ["reflect.write"]), [], ["reflect.write"],
  );
  expect(required.schemaOk).toBe(false);
  expect(required.detail).toContain("data/text");
});

const checkRaw = (name: string, args: Record<string, unknown>) => checkToolCalls(
  [{ id: "test", name, arguments: args }], toolSchemas(registry, [name]), [], [name],
);

test("rejected pattern spells out the accepted pattern and the field description", () => {
  const result = checkRaw("script_write", { filename: ">probe.mjs", code: "x", reason: "写入" });
  expect(result.schemaOk).toBe(false);
  expect(result.faultCode).toBe("wrong_type");
  expect(result.detail).toContain("accepted:");
  expect(result.detail).toContain("pattern=^[A-Za-z0-9][A-Za-z0-9._-]*");
  expect(result.detail).toContain("以 .sh / .py / .js / .mjs / .cjs 结尾");
});

test("unknown fields list the fields the object actually declares", () => {
  const result = checkRaw("script_write", { filename: "probe.mjs", code: "x", reason: "写入", invoke: "x" });
  expect(result.schemaOk).toBe(false);
  expect(result.detail).toContain('unknown field "invoke"');
  expect(result.detail).toContain("valid fields: filename, code, reason");
});

test("range violations report the declared minimum and maximum", () => {
  const result = checkRaw("local.fs_list", { path: "/tmp", limit: 5000 });
  expect(result.schemaOk).toBe(false);
  expect(result.detail).toContain("accepted:");
  expect(result.detail).toContain("max=1000");
  expect(result.detail).toContain("type=integer");
});

test("missing required fields still name every absent argument", () => {
  const result = checkRaw("local.fs_read", {});
  expect(result.faultCode).toBe("missing_required");
  expect(result.missing).toEqual(["items"]);
  expect(result.detail).toContain("missing required: items");
});
