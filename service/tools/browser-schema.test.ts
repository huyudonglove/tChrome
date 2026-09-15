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
    const base = name === "open_tab" ? { windowId: 1 } : {};
    expect(check(name, base).schemaOk).toBe(true);
    if (name === "open_tab") expect(check(name, {}).schemaOk).toBe(false);
    for (const url of ["https://example.com/path", "about:blank", "chrome://extensions/"]) {
      expect(check(name, { ...base, url }).schemaOk).toBe(true);
    }
    for (const url of [true, false, { url: "https://example.com" }, ["https://example.com"], 42, null, ""]) {
      expect(check(name, { ...base, url }).schemaOk).toBe(false);
    }
    expect(check(name, { tabId: 123 }).schemaOk).toBe(false);
    expect(check(name, { urls: ["https://example.com"] }).schemaOk).toBe(false);
  }
});

test("move_tab validates zero-based positions and the move-to-end sentinel", () => {
  expect(check("move_tab", {}).schemaOk).toBe(false);
  for (const args of [{}, { tabId: 123, index: -1 }, { index: 0 }, { index: 3 }, { index: "3" }]) {
    expect(check("move_tab", { tabId: 123, ...args }).schemaOk).toBe(true);
  }
  for (const index of [-2, 1.5, true, {}, "middle"]) {
    expect(check("move_tab", { tabId: 123, index }).schemaOk).toBe(false);
  }
  expect(check("move_tab", { tabId: 123, position: 2 }).schemaOk).toBe(false);
});

test("update_tab requires at least one explicit state and validates both booleans", () => {
  for (const args of [{ pinned: true }, { muted: false }, { tabId: 123, pinned: false, muted: true }, { muted: "false" }]) {
    expect(check("update_tab", { tabId: 123, ...args }).schemaOk).toBe(true);
  }
  expect(check("update_tab", {}).schemaOk).toBe(false);
  expect(check("update_tab", { tabId: 123 }).schemaOk).toBe(false);
  for (const value of [0, 1, "yes", null, {}]) {
    expect(check("update_tab", { tabId: 123, pinned: value }).schemaOk).toBe(false);
    expect(check("update_tab", { tabId: 123, muted: value }).schemaOk).toBe(false);
  }
  expect(check("update_tab", { tabId: 123, pinned: true, mute: true }).schemaOk).toBe(false);
});

test("detach_debugger requires explicit tabId and rejects non-numeric or malformed parameters", () => {
  expect(check("detach_debugger", {}).schemaOk).toBe(false);
  expect(check("detach_debugger", { tabId: 123 }).schemaOk).toBe(true);
  expect(check("detach_debugger", { tabId: "invalid" }).schemaOk).toBe(false);
  expect(check("detach_debugger", { tabId: null }).schemaOk).toBe(false);
});


test("window and group operations require their explicit targets", () => {
  for (const name of ["close_window", "update_window"]) {
    expect(check(name, {}).schemaOk).toBe(false);
    expect(check(name, { windowId: 2 }).schemaOk).toBe(true);
  }
  for (const name of ["group_tabs", "ungroup_tabs"]) {
    expect(check(name, { tabId: 1 }).schemaOk).toBe(false);
    expect(check(name, { tabIds: [] }).schemaOk).toBe(false);
    expect(check(name, { tabIds: [1, 2] }).schemaOk).toBe(true);
  }
});
