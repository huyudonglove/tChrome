import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadToolRegistry, toolSchemas } from "./registry.ts";
import { checkToolCalls } from "./schema.ts";
import { runCompoundTool } from "./compound-tools.ts";
import { executeTool } from "./execute.ts";
import type { BrowserHost } from "../types.ts";

const repoRoot = join(import.meta.dir, "../..");

test("compound tools are registered in baseTools and schemas are valid", () => {
  const registry = loadToolRegistry(repoRoot);
  for (const name of ["page.click_role", "page.fill_role", "page.submit_wait", "page.select_role", "page.click_text", "page.fill_submit"] as const) {
    expect(registry.toolGroups.baseToolsIds).toContain(name);
    expect(registry.tools[name]).toBeTruthy();
  }
  const tools = toolSchemas(registry, ["page.click_role", "page.fill_role", "page.submit_wait"]);
  const ok = checkToolCalls([
    { id: "c1", name: "page.click_role", arguments: { reason: "点提交", tabId: 1, role: "button", name: "提交" } },
    { id: "c2", name: "page.fill_role", arguments: { reason: "填邮箱", tabId: 1, role: "textbox", name: "邮箱", text: "a@b.c" } },
    { id: "c3", name: "page.submit_wait", arguments: { reason: "提交并等待", tabId: 1, id: "e_03", urlContains: "/api/save" } },
  ], tools, [], ["page.click_role", "page.fill_role", "page.submit_wait"]);
  expect(ok.schemaOk).toBe(true);
});

test("page.select_role and page.click_text compose primitives", async () => {
  const host = {
    execute: async (name: string, args: Record<string, unknown>) => {
      if (name === "page.get_by_role") return { ok: true, total: 1, elements: [{ id: "e_11", role: "combobox", name: "城市" }] };
      if (name === "combo.select") return { ok: true, value: args.value, text: "上海" };
      if (name === "find_on_page") return { ok: true, total: 2, elements: [{ id: "e_21", text: "下一步" }, { id: "e_22", text: "下一步草稿" }] };
      if (name === "page.click") return { ok: true, clicked: true, id: args.id };
      return { ok: false };
    },
  } as unknown as BrowserHost;
  const selected = await runCompoundTool("page.select_role", { tabId: 1, role: "combobox", name: "城市", value: "上海", reason: "s" }, host);
  expect(selected).toMatchObject({ ok: true, id: "e_11", value: "上海" });
  const ambiguous = await runCompoundTool("page.click_text", { tabId: 1, text: "下一步", reason: "c" }, host);
  expect(ambiguous.faultCode).toBe("ambiguous_target");
  const clicked = await runCompoundTool("page.click_text", { tabId: 1, text: "下一步", matchIndex: 0, reason: "c" }, host);
  expect(clicked).toMatchObject({ ok: true, id: "e_21", clicked: true });
});

test("page.fill_submit fills fields then submits and waits", async () => {
  const typed: string[] = [];
  const host = {
    execute: async (name: string, args: Record<string, unknown>) => {
      if (name === "page.get_by_role") {
        const role = String(args.role);
        const id = role === "button" ? "e_30" : `e_${role}`;
        return { ok: true, total: 1, elements: [{ id, role, name: args.name }] };
      }
      if (name === "page.type") { typed.push(String(args.text)); return { ok: true, value: args.text }; }
      if (name === "page.click") return { ok: true, clicked: true, id: args.id };
      if (name === "wait_response") return { ok: true, url: "https://x/api/reg", status: 200 };
      return { ok: false };
    },
  } as unknown as BrowserHost;
  const out = await runCompoundTool("page.fill_submit", {
    tabId: 4,
    reason: "注册",
    fields: [
      { role: "textbox", name: "用户", text: "u1" },
      { role: "textbox", name: "邮箱", text: "a@b.c" },
    ],
    submit: { role: "button", name: "注册", waitUrlContains: "/api/reg" },
  }, host);
  expect(typed).toEqual(["u1", "a@b.c"]);
  expect(out).toMatchObject({ ok: true, submit: { id: "e_30", clicked: true } });
});

test("page.click_role locates, clicks, and optionally waits without silent pick", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const host = {
    execute: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "page.get_by_role") return { ok: true, tabId: 1, total: 2, elements: [{ id: "e_01", role: "button", name: "提交" }, { id: "e_02", role: "button", name: "提交草稿" }] };
      if (name === "page.click") return { ok: true, clicked: true, id: args.id };
      if (name === "wait_response") return { ok: true, url: "https://x/api/save", status: 200, requestId: "r1" };
      return { ok: false, error: "unexpected" };
    },
  } as unknown as BrowserHost;

  const ambiguous = await runCompoundTool("page.click_role", { tabId: 1, role: "button", name: "提交", reason: "x" }, host);
  expect(ambiguous.ok).toBe(false);
  expect(ambiguous.faultCode).toBe("ambiguous_target");

  const done = await runCompoundTool("page.click_role", { tabId: 1, role: "button", name: "提交", matchIndex: 0, waitUrlContains: "/api/save", reason: "x" }, host);
  expect(done).toMatchObject({ ok: true, id: "e_01", clicked: true });
  expect(calls.filter(c => c.name === "page.click")).toHaveLength(1);
});

test("page.fill_role types after locate; page.submit_wait clicks then reports wait", async () => {
  const host = {
    execute: async (name: string, args: Record<string, unknown>) => {
      if (name === "page.get_by_role") return { ok: true, total: 1, elements: [{ id: "e_09", role: "textbox", name: "搜索" }] };
      if (name === "page.type") return { ok: true, value: args.text };
      if (name === "page.click") return { ok: true, clicked: true, id: args.id };
      if (name === "wait_response") return { ok: false, timeout: true, url: args.urlContains };
      return { ok: false };
    },
  } as unknown as BrowserHost;
  const filled = await runCompoundTool("page.fill_role", { tabId: 2, role: "textbox", name: "搜索", text: "hello", reason: "s" }, host);
  expect(filled).toMatchObject({ ok: true, id: "e_09", value: "hello" });
  const submitted = await runCompoundTool("page.submit_wait", { tabId: 2, id: "e_09", urlContains: "/search", reason: "s" }, host);
  expect(submitted.ok).toBe(false);
  expect(submitted.step).toBe("wait_response");
});

test("executeTool routes compound names through host bridge", async () => {
  const execution = await executeTool({
    name: "page.click_role",
    arguments: { reason: "点", tabId: 3, role: "button", name: "确定", matchIndex: 0 },
    dataDir: "",
    browserNames: [],
    host: {
      execute: async (name: string) => {
        if (name === "page.get_by_role") return { ok: true, total: 1, elements: [{ id: "e_05", role: "button", name: "确定" }] };
        if (name === "page.click") return { ok: true, clicked: true, id: "e_05" };
        return { ok: false };
      },
    } as unknown as BrowserHost,
    lookup: { unusedTools: [], knownTools: [], enabledTools: [] },
  });
  expect(JSON.parse(execution.text)).toMatchObject({ ok: true, id: "e_05", clicked: true });
});
