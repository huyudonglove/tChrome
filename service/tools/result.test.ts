import { expect, test } from "bun:test";
import { executeTool } from "./execute.ts";
import { failedTool, normalizeToolExecution } from "./result.ts";

const input = { dataDir: "/tmp", lookup: { knownTools: [], enabledTools: [], unusedTools: [] }, browserNames: [] };

test("public boundary preserves missing-file diagnostics", async () => {
  const execution = await executeTool({ ...input, name: "execute_javascript", arguments: { filename: "missing-error-contract.js" }, host: { execute: async () => { throw Error("must not execute"); } } });
  expect(JSON.parse(execution.text)).toMatchObject({ ok: false, faultCode: "file_not_found", recovery: "inspect_state", details: { reason: expect.any(String) }, toolName: "execute_javascript" });
  expect(execution.effects).toEqual([]);
});

test("browser timeout preserves tabId and advises inspection without replay", async () => {
  let calls = 0;
  const execution = await executeTool({ ...input, name: "page_click", arguments: {}, browserNames: ["page_click"], host: { execute: async () => { calls++; return { ok: false, faultCode: "tool_timeout", tabId: 7, error: "diagnostic" }; } } });
  expect(JSON.parse(execution.text)).toMatchObject({ ok: false, faultCode: "tool_timeout", recovery: "inspect_state", tabId: 7, details: { reason: "diagnostic" } });
  expect(calls).toBe(1);
  // Failed tab-targeted calls still log a page observation.
  expect(execution.effects).toEqual([{
    type: "page.set",
    page: { tabId: 7, url: "", title: "", description: "当前页面信息" },
    result: { ok: false, faultCode: "tool_timeout", tabId: 7, error: "diagnostic" },
  }]);
});

test("HTTP batch normalizes failures and retains successful rows and effects", () => {
  const execution = { text: JSON.stringify({ ok: true, results: [{ ok: true, body: "value" }, { ok: false, status: 503, url: "https://example.test", error: "unavailable" }] }), effects: [{ type: "queue.clear" as const }] };
  const normalized = normalizeToolExecution(execution, "send_http_batch");
  expect(JSON.parse(normalized.text).results).toEqual([{ ok: true, body: "value" }, expect.objectContaining({ ok: false, faultCode: "http_error", status: 503, url: "https://example.test", details: { reason: "unavailable" } })]);
  expect(normalized.effects).toBe(execution.effects);
});

test("failedTool preserves raw reason in details from a bare string", () => {
  expect(JSON.parse(failedTool("key 空着", "invalid_arguments").text)).toMatchObject({
    faultCode: "invalid_arguments",
    message: expect.stringMatching(/^runtime: /),
    details: { reason: "key 空着" },
  });
});

test("failure normalization retains domain diagnostics and recovery across repeated normalization", () => {
  const value = {
    ok: false, faultCode: "local_git_failed", message: "fatal: unknown revision missing-ref",
    error: { code: 128, stderr: "unknown revision missing-ref" }, detail: "git diff failed",
    recovery: { action: "choose_revision", refs: ["HEAD"] }, details: { reason: "original reason", command: "git diff" },
  };
  const normalized = normalizeToolExecution({ text: JSON.stringify(value), effects: [] }, "local_git_diff");
  expect(JSON.parse(normalized.text)).toEqual({ toolName: "local_git_diff", ...value });
  expect(normalizeToolExecution(normalized, "local_git_diff")).toEqual(normalized);
  const arrayDetails = { ...value, details: ["stderr diagnostic"], message: null, recovery: null };
  expect(JSON.parse(normalizeToolExecution({ text: JSON.stringify(arrayDetails), effects: [] }).text)).toEqual(arrayDetails);
});

test("message-only Git errors retain their concrete reason at the public boundary", async () => {
  const execution = await executeTool({ ...input, conversationId: "test", name: "local_git_status", arguments: { path: "relative-path" } });
  expect(JSON.parse(execution.text)).toMatchObject({
    ok: false, message: "path must be an absolute path", details: { reason: "path must be an absolute path" },
  });
});

test("successful business payloads are not interpreted as tool errors", () => {
  const value = { ok: true, value: { error: "business value" }, results: [{ ok: false, error: "business row" }] };
  expect(JSON.parse(normalizeToolExecution({ text: JSON.stringify(value), effects: [] }, "execute_javascript").text)).toEqual(value);
  expect(JSON.parse(failedTool({ faultCode: "future_error", message: "internal" }).text)).toMatchObject({ faultCode: "future_error", recovery: "inspect_state", details: { reason: "internal" } });
});
