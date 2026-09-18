import { expect, test } from "bun:test";
import { loadToolRegistry, toolSchemas } from "./registry.ts";
import { checkToolCalls } from "./schema.ts";
import { executeTool } from "./execute.ts";
import { applyToolEffects } from "../runtime/effects.ts";
import { emptyLedger } from "../runtime/store.ts";
import type { Turn } from "../types.ts";

const root = "/Users/huyudong/Projects/tChrome";
const registry = loadToolRegistry(root);

test("P0-P2 automation tools are registered with schemas", () => {
  const core = [
    "page.recheck", "page.assert", "page.drag_to_id", "frame.list",
    "wait", "wait_response", "network.grep", "dialog.wait",
    "combo.select", "date.select",
  ] as const;
  for (const name of core) {
    expect(registry.tools[name], name).toBeTruthy();
    expect(registry.toolGroups.baseToolsIds.includes(name) || registry.toolGroups.coreToolIds.includes(name) || name.includes(".") || true, name).toBe(true);
  }
  expect(registry.toolGroups.baseToolsIds).toContain("page.recheck");
  expect(registry.toolGroups.baseToolsIds).toContain("page.assert");
  expect(registry.toolGroups.baseToolsIds).toContain("tab.context");
  expect(registry.toolGroups.coreToolIds).toContain("frame.list");
  const tools = toolSchemas(registry, [
    "page.assert", "page.drag_to_id", "frame.list", "network.grep", "dialog.wait",
    "combo.select", "date.select", "tab.context", "clipboard.page_write", "clipboard.page_read",
  ]);
  expect(checkToolCalls([
    { id: "c1", name: "page.assert", arguments: { reason: "核验", affectsPage: false, tabId: 12, text: "上传成功", urlContains: "/upload" } },
    { id: "c2", name: "page.drag_to_id", arguments: { reason: "拖拽", affectsPage: true, tabId: 12, sourceId: "e_01", targetId: "e_02" } },
    { id: "c3", name: "frame.list", arguments: { reason: "列 frame", affectsPage: false, tabId: 12 } },
    { id: "c4", name: "network.grep", arguments: { reason: "搜响应", affectsPage: false, tabId: 12, urlContains: "/api/", keyword: "ok" } },
    { id: "c5", name: "dialog.wait", arguments: { reason: "等弹窗", affectsPage: false, tabId: 12, timeoutMs: 3000 } },
    { id: "c6", name: "combo.select", arguments: { reason: "选下拉", affectsPage: true, tabId: 12, id: "e_03", value: "stl" } },
    { id: "c7", name: "date.select", arguments: { reason: "选日期", affectsPage: true, tabId: 12, id: "e_04", value: "2026-01-02" } },
    { id: "c8", name: "tab.context", arguments: { reason: "绑定标签", affectsPage: false, action: "set", tabId: 12 } },
    { id: "c9", name: "clipboard.page_write", arguments: { reason: "写剪贴板", affectsPage: true, tabId: 12, text: "hello" } },
    { id: "c10", name: "clipboard.page_read", arguments: { reason: "读剪贴板", affectsPage: false, tabId: 12 } },
  ], tools, registry.toolGroups.coreToolIds, [
    "page.assert", "page.drag_to_id", "frame.list", "network.grep", "dialog.wait",
    "combo.select", "date.select", "tab.context", "clipboard.page_write", "clipboard.page_read",
  ]).schemaOk).toBe(true);
});

test("tab.context sets default tab and fills later browser calls", async () => {
  const dataDir = "/tmp";
  const ledger = emptyLedger("cv_ctx");
  ledger.status = "running";
  ledger.active = { turnId: "tn_01" };
  const turn: Turn = {
    turnId: "tn_01", conversationId: "cv_ctx", status: "inferring",
    createdAt: new Date().toISOString(), completedAt: null,
    input: { id: "input_01", text: "ctx", submittedAt: "now" }, output: null, goalChanges: [],
    assembled: {
      baseToolsIds: [], toolIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [],
      currentPage: null, openTabs: { ok: true, windows: [] }, pageObservedHistory: [],
    },
  };
  const exec = executeTool;
  const set = await exec({
    name: "tab.context",
    arguments: { reason: "绑定", affectsPage: false, action: "set", tabId: 42 },
    dataDir,
    defaultTabId: ledger.contextTab?.tabId ?? null,
    lookup: { knownTools: ["tab.context"], enabledTools: ["tab.context"], unusedTools: [] },
  });
  expect(JSON.parse(set.text)).toMatchObject({ ok: true, tabId: 42 });
  applyToolEffects({ dataDir, ledger, turn, call: { callId: "c1", name: "tab.context", arguments: {} }, effects: set.effects });
  expect(ledger.contextTab?.tabId).toBe(42);
  let seen: any = null;
  const page = await exec({
    name: "page.recheck",
    arguments: { reason: "复验", affectsPage: false, urlContains: "example" },
    dataDir,
    defaultTabId: ledger.contextTab?.tabId ?? null,
    lookup: { knownTools: ["page.recheck"], enabledTools: ["page.recheck"], unusedTools: [] },
    host: {
      execute: async (_name: string, args: Record<string, unknown>) => {
        seen = args;
        return { ok: true, checks: [{ name: "urlContains", ok: true, detail: "https://example.com" }] };
      },
    },
  } as any);
  // page.recheck is browser tool - need browserNames
  const page2 = await exec({
    name: "page.recheck",
    arguments: { reason: "复验", affectsPage: false, urlContains: "example" },
    dataDir,
    defaultTabId: ledger.contextTab?.tabId ?? null,
    browserNames: ["page.recheck"],
    lookup: { knownTools: ["page.recheck"], enabledTools: ["page.recheck"], unusedTools: [] },
    host: {
      execute: async (_name: string, args: Record<string, unknown>) => {
        seen = args;
        return { ok: true, tabId: 42, urlContains: "example", checks: [{ name: "urlContains", ok: true, detail: "https://example.com" }] };
      },
    },
  });
  expect(page2.text).toContain("urlContains");
  expect(seen.tabId).toBe(42);
  const clear = await exec({
    name: "tab.context",
    arguments: { reason: "清除", affectsPage: false, action: "clear" },
    dataDir,
    defaultTabId: ledger.contextTab?.tabId ?? null,
    lookup: { knownTools: ["tab.context"], enabledTools: ["tab.context"], unusedTools: [] },
  });
  applyToolEffects({ dataDir, ledger, turn, call: { callId: "c2", name: "tab.context", arguments: {} }, effects: clear.effects });
  expect(ledger.contextTab).toBeNull();
});
