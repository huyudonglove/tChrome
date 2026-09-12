import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProvider } from "./uuapi.ts";
import { handleTurn } from "../runtime/loop.ts";
import { loadLedger } from "../runtime/store.ts";
import OpenAI from "openai";
import { classifyProviderFailure } from "./failures.ts";

test("failure policy distinguishes transport errors, local errors, and cancellation", () => {
  for (const error of [new OpenAI.APIConnectionError({}), new OpenAI.APIConnectionTimeoutError()]) {
    expect(classifyProviderFailure(error)).toEqual({ faultCode: "provider_error", retryable: true });
  }
  expect(classifyProviderFailure(new Error("local failure"))).toEqual({ faultCode: "provider_error", retryable: false });
  expect(classifyProviderFailure(new OpenAI.APIUserAbortError())).toEqual({ faultCode: "stopped", retryable: false });
});

const input = { messages: [], tools: [] };
const args = JSON.stringify({ reason: "test", affectsPage: false, key: "kept", value: "yes" });
const chatCall = { id: "valid", type: "function", function: { name: "notes.write", arguments: args } };
const responseCall = { type: "function_call", status: "completed", call_id: "valid", name: "notes.write", arguments: args };
const chat = (finish: string, message: Record<string, unknown> = { content: "partial", tool_calls: [chatCall] }) => ({
  choices: [{ message: { role: "assistant", ...message }, finish_reason: finish }],
});
const responses = (status: string, extra: Record<string, unknown> = {}) => ({ status, output: [responseCall], ...extra });
const cases = [
  { name: "output limit rejects partial tools", fault: "provider_output_limit", chat: chat("length"), responses: responses("incomplete", { incomplete_details: { reason: "max_output_tokens" } }) },
  { name: "content filter rejects partial tools", fault: "provider_refused", chat: chat("content_filter"), responses: responses("incomplete", { incomplete_details: { reason: "content_filter" } }) },
  { name: "explicit refusal rejects sibling tools", fault: "provider_refused", chat: chat("tool_calls", { content: null, refusal: "refused", tool_calls: [chatCall] }), responses: responses("completed", { output: [responseCall, { type: "message", content: [{ type: "refusal", refusal: "refused" }] }] }) },
  { name: "missing result array", fault: "provider_invalid_response", chat: {}, responses: { status: "completed" } },
  { name: "empty result array", fault: "provider_invalid_response", chat: { choices: [] }, responses: responses("completed", { output: [] }) },
  { name: "malformed result array", fault: "provider_invalid_response", chat: { choices: {} }, responses: responses("completed", { output: {} }) },
  { name: "malformed message", fault: "provider_invalid_response", chat: { choices: [{ finish_reason: "stop", message: null }] }, responses: responses("completed", { output: [{ type: "message", content: null }] }) },
  { name: "empty content", fault: "provider_invalid_response", chat: chat("stop", { content: " ", tool_calls: [] }), responses: responses("completed", { output: [{ type: "message", content: [{ type: "output_text", text: " " }] }] }) },
  { name: "malformed call rejects valid sibling", fault: "provider_invalid_response", chat: chat("tool_calls", { content: null, tool_calls: [chatCall, { id: "bad", type: "function", function: null }] }), responses: responses("completed", { output: [responseCall, { type: "function_call", call_id: "bad", name: "notes.write", arguments: null }] }) },
];

for (const scenario of cases) {
  test(`Chat/Responses parity: ${scenario.name}`, async () => {
    for (const api of ["chat", "responses"] as const) {
      let requests = 0;
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
        requests++;
        return Response.json(scenario[api]);
      } });
      try {
        const result = await createProvider({ api, apiKey: "local-test", proxy: "", baseURL: `http://127.0.0.1:${server.port}/v1` }).complete(input);
        expect(result).toMatchObject({ finish: "error", faultCode: scenario.fault, attempts: 1, toolCalls: [], parseOk: false });
        expect(result.toolCallFaults).toBeUndefined();
        expect(requests).toBe(1);
      } finally { server.stop(true); }
    }
  });
}

test("Responses other incomplete reason is terminal", async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    requests++;
    return Response.json(responses("incomplete", { incomplete_details: { reason: "unknown_reason" } }));
  } });
  try {
    const result = await createProvider({ api: "responses", apiKey: "local-test", proxy: "", baseURL: `http://127.0.0.1:${server.port}/v1` }).complete(input);
    expect(result).toMatchObject({ finish: "error", faultCode: "provider_incomplete", attempts: 1, toolCalls: [] });
    expect(requests).toBe(1);
  } finally { server.stop(true); }
});

for (const status of [400, 401, 403, 408, 429, 500, 503]) {
  test(`Chat/Responses HTTP ${status} use identical retry policy`, async () => {
    await Promise.all((["chat", "responses"] as const).map(async api => {
      let requests = 0;
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
        requests++;
        return Response.json({ error: { message: "local-test" } }, { status });
      } });
      try {
        const result = await createProvider({ api, apiKey: "local-test", proxy: "", baseURL: `http://127.0.0.1:${server.port}/v1` }).complete(input);
        const expectedAttempts = status === 408 || status === 429 || status >= 500 ? 3 : 1;
        expect(result).toMatchObject({ finish: "error", faultCode: status === 401 || status === 403 ? "provider_key_invalid" : "provider_error", attempts: expectedAttempts, toolCalls: [] });
        expect(requests).toBe(expectedAttempts);
      } finally { server.stop(true); }
    }));
  });
}

test("Chat/Responses local input errors do not retry or request", async () => {
  for (const api of ["chat", "responses"] as const) {
    let requests = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return Response.json({}); } });
    try {
      const result = await createProvider({ api, apiKey: "local-test", proxy: "", baseURL: `http://127.0.0.1:${server.port}/v1` }).complete({
        messages: [{ role: "user", content: "image", images: [{ id: "image_1", path: "missing.png", width: 1, height: 1, mimeType: "image/png", bytes: 1 }] }], tools: [],
      });
      expect(result).toMatchObject({ finish: "error", faultCode: "provider_error", attempts: 1, toolCalls: [] });
      expect(requests).toBe(0);
    } finally { server.stop(true); }
  }
});

test("Chat/Responses SDK connection failures retry", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}) });
  const port = server.port;
  server.stop(true);
  await Promise.all((["chat", "responses"] as const).map(async api => {
    const result = await createProvider({ api, apiKey: "local-test", proxy: "", baseURL: `http://127.0.0.1:${port}/v1` }).complete(input);
    expect(result).toMatchObject({ finish: "error", faultCode: "provider_error", attempts: 3, toolCalls: [] });
  }));
});

test("Chat/Responses Runtime never executes tools from output-limited responses", async () => {
  for (const api of ["chat", "responses"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "tchrome-failure-parity-"));
    let requests = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return Response.json(cases[0]![api]); } });
    try {
      const provider = createProvider({ api, apiKey: "local-test", proxy: "", baseURL: `http://127.0.0.1:${server.port}/v1` });
      const result = await handleTurn({ dataDir: dir, repoRoot: resolve(import.meta.dir, "../.."), provider }, { userInput: "写入笔记", submittedAt: "now" });
      expect(result.output).toEqual({ kind: "error", faultCode: "provider_output_limit" });
      const ledger = loadLedger(dir, result.conversationId);
      expect(ledger.notes.kept).toBeUndefined();
      expect(ledger.toolIO).toEqual([]);
      expect(requests).toBe(1);
    } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
  }
});
