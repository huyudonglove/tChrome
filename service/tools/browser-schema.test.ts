import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadToolRegistry, toolSchemas } from "./registry.ts";
import { checkToolCalls } from "./schema.ts";

const registry = loadToolRegistry(join(import.meta.dir, "../.."));
const check = (name: string, args: Record<string, unknown>) => checkToolCalls(
  [{ id: "call_01", name, arguments: { reason: "管理浏览器标签", affectsPage: true, ...args } }],
  toolSchemas(registry, [name]), [], [name],
);

test("browser creation tools accept optional link strings and reject malformed argument types", () => {
  for (const name of ["open_tab", "create_window"]) {
    expect(check(name, {}).schemaOk).toBe(true);
    for (const url of ["https://example.com/path", "about:blank", "chrome://extensions/"]) {
      expect(check(name, { url }).schemaOk).toBe(true);
    }
    for (const url of [true, false, { url: "https://example.com" }, ["https://example.com"], 42, null, ""]) {
      expect(check(name, { url }).schemaOk).toBe(false);
    }
    expect(check(name, { tab: 123 }).schemaOk).toBe(false);
    expect(check(name, { urls: ["https://example.com"] }).schemaOk).toBe(false);
  }
});

test("move_tab validates zero-based positions and the move-to-end sentinel", () => {
  for (const args of [{}, { tab: 123, index: -1 }, { index: 0 }, { index: 3 }, { index: "3" }]) {
    expect(check("move_tab", args).schemaOk).toBe(true);
  }
  for (const index of [-2, 1.5, true, {}, "middle"]) {
    expect(check("move_tab", { index }).schemaOk).toBe(false);
  }
  expect(check("move_tab", { position: 2 }).schemaOk).toBe(false);
});

test("update_tab requires at least one explicit state and validates both booleans", () => {
  for (const args of [{ pinned: true }, { muted: false }, { tab: 123, pinned: false, muted: true }, { muted: "false" }]) {
    expect(check("update_tab", args).schemaOk).toBe(true);
  }
  expect(check("update_tab", {}).schemaOk).toBe(false);
  expect(check("update_tab", { tab: 123 }).schemaOk).toBe(false);
  for (const value of [0, 1, "yes", null, {}]) {
    expect(check("update_tab", { pinned: value }).schemaOk).toBe(false);
    expect(check("update_tab", { muted: value }).schemaOk).toBe(false);
  }
  expect(check("update_tab", { pinned: true, mute: true }).schemaOk).toBe(false);
});

test("detach_debugger accepts optional tab and rejects non-numeric or malformed parameters", () => {
  expect(check("detach_debugger", {}).schemaOk).toBe(true);
  expect(check("detach_debugger", { tab: 123 }).schemaOk).toBe(true);
  expect(check("detach_debugger", { tab: "invalid" }).schemaOk).toBe(false);
  expect(check("detach_debugger", { tab: null }).schemaOk).toBe(false);
});
