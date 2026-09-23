import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProvider } from "./uuapi.ts";
import { sseResponse } from "./sse.ts";
import { handleTurn } from "../runtime/loop.ts";
import { loadLedger } from "../runtime/store.ts";
import OpenAI from "openai";
import { classifyProviderFailure } from "./failures.ts";
import { runtimeConfig } from "../config/runtime.ts";

test("failure policy distinguishes transport errors, local errors, and cancellation", () => {
  for (const error of [new OpenAI.APIConnectionError({}), new OpenAI.APIConnectionTimeoutError()]) {
    expect(classifyProviderFailure(error)).toEqual({ faultCode: "provider_error", retryable: true });
  }
  expect(classifyProviderFailure(new Error("local failure"))).toEqual({ faultCode: "provider_error", retryable: false });
  expect(classifyProviderFailure(new OpenAI.APIUserAbortError())).toEqual({ faultCode: "stopped", retryable: false });
});

const input = { messages: [], tools: [] };
const args = JSON.stringify({ reason: "test", key: "kept", value: "yes" });
const chatCall = { id: "valid", type: "function", function: { name: "notes.write", arguments: args } };
const responseCall = { type: "function_call", status: "completed", call_id: "valid", name: "notes.write", arguments: args };

const chatSse = (finish: string, message: Record<string, unknown> = { content: "partial", tool_calls: [chatCall] }) => {
  const events: unknown[] = [];
  const content = message.content;
  if (typeof content === "string" && content) {
    events.push({ choices: [{ index: 0, delta: { content } }] });
  }
  if (message.refusal) events.push({ choices: [{ index: 0, delta: { refusal: String(message.refusal) } }] });
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const [index, call] of toolCalls.entries()) {
    const row = call as { id?: string; function?: { name?: string; arguments?: string } | null };
    if (!row?.function) {
      events.push({ choices: [{ index: 0, delta: { tool_calls: [{ index }] } }] });
      continue;
    }
    events.push({
      choices: [{ index: 0, delta: { tool_calls: [{ index, id: row.id, function: { name: row.function.name, arguments: row.function.arguments } }] } }],
    });
  }
  events.push({ choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  return sseResponse(events);
};

const responsesSse = (status: string, extra: Record<string, unknown> = {}) => {
  const output = Array.isArray(extra.output) ? extra.output
    : extra.output !== undefined ? []
    : [responseCall];
  const events: unknown[] = [];
  if (status === "completed") {
    for (const item of output) {
      const row = item as { type?: string; content?: { type?: string; text?: string }[] };
      if (row.type === "message") {
        for (const part of row.content ?? []) {
          if (part.type === "output_text" && part.text) events.push({ type: "response.output_text.delta", delta: part.text });
          if (part.type === "refusal") events.push({ type: "response.refusal.done" });
        }
      } else if (row.type === "function_call") {
        events.push({ type: "response.output_item.done", item: row });
      }
    }
    events.push({ type: "response.completed", response: { status: "completed", output, ...extra } });
  } else if (status === "incomplete") {
    events.push({ type: "response.incomplete", response: { status: "incomplete", output, ...extra } });
  } else {
    events.push({ type: "response.failed", response: { status, output, ...extra } });
  }
  return sseResponse(events);
};

const chat = (finish: string, message: Record<string, unknown> = { content: "partial", tool_calls: [chatCall] }) => () => chatSse(finish, message);
const responses = (status: string, extra: Record<string, unknown> = {}) => () => responsesSse(status, extra);
const cases = [
  { name: "output limit rejects partial tools", fault: "provider_output_limit", chat: chat("length"), responses: responses("incomplete", { incomplete_details: { reason: "max_output_tokens" } }) },
  { name: "content filter rejects partial tools", fault: "provider_refused", chat: chat("content_filter"), responses: responses("incomplete", { incomplete_details: { reason: "content_filter" } }) },
  { name: "explicit refusal rejects sibling tools", fault: "provider_refused", chat: chat("tool_calls", { content: null, refusal: "refused", tool_calls: [chatCall] }), responses: responses("completed", { output: [responseCall, { type: "message", content: [{ type: "refusal", refusal: "refused" }] }] }) },
  { name: "missing result array", fault: "provider_invalid_response", chat: () => sseResponse([]), responses: responses("completed", { output: [] }) },
  { name: "empty result array", fault: "provider_invalid_response", chat: () => sseResponse([{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]), responses: responses("completed", { output: [] }) },
  { name: "malformed result array", fault: "provider_invalid_response", chat: () => sseResponse([{ choices: {} }]), responses: responses("completed", { output: [] }) },
  { name: "malformed message", fault: "provider_invalid_response", chat: () => sseResponse([{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]), responses: responses("completed", { output: [{ type: "message", content: null }] }) },
  { name: "empty content", fault: "provider_invalid_response", chat: chat("stop", { content: " ", tool_calls: [] }), responses: responses("completed", { output: [{ type: "message", content: [{ type: "output_text", text: " " }] }] }) },
  { name: "malformed call rejects valid sibling", fault: "provider_invalid_response", chat: chat("tool_calls", { content: null, tool_calls: [chatCall, { id: "bad", type: "function", function: null }] }), responses: responses("completed", { output: [responseCall, { type: "function_call", call_id: "bad", name: "notes.write", arguments: null }] }) },
];

for (const scenario of cases) {
  const expectedAttempts = scenario.fault === "provider_invalid_response" ? runtimeConfig.network.maxAttempts : 1;
  test(`Chat/Responses parity: ${scenario.name}`, async () => {
    for (const api of ["chat", "responses"] as const) {
      let requests = 0;
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
        requests++;
        return scenario[api]();
      } });
      try {
        const result = await createProvider({ api, apiKey: "local-test", proxy: "", baseURL: `http://127.0.0.1:${server.port}/v1` }).complete(input);
        expect(result).toMatchObject({ finish: "error", faultCode: scenario.fault, attempts: expectedAttempts, toolCalls: [], parseOk: false });
        expect(result.toolCallFaults).toBeUndefined();
        expect(requests).toBe(expectedAttempts);
      } finally { server.stop(true); }
    }
  }, expectedAttempts > 1 ? 60_000 : 15_000);
}

test("invalid response retries silently and uses the first valid completion", async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    requests++;
    if (requests < 3) return chat("stop", { content: " ", tool_calls: [] })();
    return chat("stop", { content: "ok", tool_calls: [] })();
  } });
  try {
    const result = await createProvider({ api: "chat", apiKey: "local-test", proxy: "", baseURL: `http://127.0.0.1:${server.port}/v1` }).complete(input);
    expect(result).toMatchObject({ finish: "stop", content: "ok", toolCalls: [], faultCode: null, attempts: 3 });
    expect(requests).toBe(3);
  } finally { server.stop(true); }
});

test("Responses other incomplete reason is terminal", async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    requests++;
    return responses("incomplete", { incomplete_details: { reason: "unknown_reason" } })();
  } });
  try {
    const result = await createProvider({ api: "responses", apiKey: "local-test", proxy: "", baseURL: `http://127.0.0.1:${server.port}/v1` }).complete(input);
    expect(result).toMatchObject({ finish: "error", faultCode: "provider_incomplete", attempts: 1, toolCalls: [] });
    expect(requests).toBe(1);
  } finally { server.stop(true); }
});

for (const status of [400, 401, 403, 408, 429, 500, 503]) {
  const expectedAttempts = status === 408 || status === 429 || status >= 500 ? runtimeConfig.network.maxAttempts : 1;
  test(`Chat/Responses HTTP ${status} use identical retry policy`, async () => {
    await Promise.all((["chat", "responses"] as const).map(async api => {
      let requests = 0;
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
        requests++;
        return Response.json({ error: { message: "local-test" } }, { status });
      } });
      try {
        const result = await createProvider({ api, apiKey: "local-test", proxy: "", baseURL: `http://127.0.0.1:${server.port}/v1` }).complete(input);
        expect(result).toMatchObject({ finish: "error", faultCode: status === 401 ? "provider_key_invalid" : status === 403 ? "provider_forbidden" : "provider_error", attempts: expectedAttempts, toolCalls: [] });
        expect(requests).toBe(expectedAttempts);
      } finally { server.stop(true); }
    }));
  }, expectedAttempts > 1 ? 30_000 : 15_000);
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
    expect(result).toMatchObject({ finish: "error", faultCode: "provider_error", attempts: runtimeConfig.network.maxAttempts, toolCalls: [] });
  }));
}, 30_000);

test("Chat/Responses Runtime never executes tools from output-limited responses", async () => {
  for (const api of ["chat", "responses"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "tchrome-failure-parity-"));
    let requests = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return cases[0]![api](); } });
    try {
      const provider = createProvider({ api, apiKey: "local-test", proxy: "", baseURL: `http://127.0.0.1:${server.port}/v1` });
      const result = await handleTurn({ dataDir: dir, repoRoot: resolve(import.meta.dir, "../.."), provider }, { userInput: "写入笔记", submittedAt: "now" });
      expect(result.output).toMatchObject({ kind: "error", faultCode: "provider_output_limit" });
      expect((result.output as { detail?: string }).detail).toBeTruthy();
      const ledger = loadLedger(dir, result.conversationId);
      expect(ledger.notes.kept).toBeUndefined();
      expect(ledger.toolIO).toEqual([]);
      expect(requests).toBe(1);
    } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
  }
});
