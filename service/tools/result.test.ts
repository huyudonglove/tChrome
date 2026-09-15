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
  const execution = await executeTool({ ...input, name: "page.click", arguments: {}, browserNames: ["page.click"], host: { execute: async () => { calls++; return { ok: false, faultCode: "tool_timeout", tabId: 7, error: "diagnostic" }; } } });
  expect(JSON.parse(execution.text)).toMatchObject({ ok: false, faultCode: "tool_timeout", recovery: "inspect_state", tabId: 7, details: { reason: "diagnostic" } });
  expect(calls).toBe(1);
  expect(execution.effects).toEqual([]);
});

test("HTTP batch normalizes failures and retains successful rows and effects", () => {
  const execution = { text: JSON.stringify({ ok: true, results: [{ ok: true, body: "value" }, { ok: false, status: 503, url: "https://example.test", error: "unavailable" }] }), effects: [{ type: "queue.clear" as const }] };
  const normalized = normalizeToolExecution(execution, "send_http_batch");
  expect(JSON.parse(normalized.text).results).toEqual([{ ok: true, body: "value" }, expect.objectContaining({ ok: false, faultCode: "http_error", status: 503, url: "https://example.test", details: { reason: "unavailable" } })]);
  expect(normalized.effects).toBe(execution.effects);
});

test("successful business payloads are not interpreted as tool errors", () => {
  const value = { ok: true, value: { error: "business value" }, results: [{ ok: false, error: "business row" }] };
  expect(JSON.parse(normalizeToolExecution({ text: JSON.stringify(value), effects: [] }, "execute_javascript").text)).toEqual(value);
  expect(JSON.parse(failedTool({ faultCode: "future_error", message: "internal" }).text)).toMatchObject({ faultCode: "future_error", recovery: "inspect_state", details: { reason: "internal" } });
});
