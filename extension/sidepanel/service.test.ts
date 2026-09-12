import { test, expect, afterEach } from "bun:test";
import { requestJSON, DOWN } from "./service";
import { errorMessage } from "../../shared/errors.ts";

const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
afterEach(() => {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
});
const reply = (body: unknown, status = 200) => {
  globalThis.fetch = (async () => Response.json(body, { status })) as unknown as typeof fetch;
};

test("HTTP failures retain server details with a shared error code", async () => {
  reply({ error: "catalog unavailable" }, 500);
  await expect(requestJSON("/turn", { method: "POST" })).rejects.toMatchObject({
    faultCode: "service_http_error", message: errorMessage("service_http_error", "user"),
    details: { status: 500, body: { error: "catalog unavailable" } },
  });
  reply({ output: { kind: "error", faultCode: "conversation_changed" } }, 409);
  await expect(requestJSON("/turn")).rejects.toMatchObject({
    faultCode: "service_http_error", details: { status: 409, body: { output: { faultCode: "conversation_changed" } } },
  });
});

test("failed switch cannot become a session", async () => {
  reply({ error: "没有这个会话" }, 404);
  await expect(requestJSON("/conversations/open")).rejects.toMatchObject({
    faultCode: "service_http_error", details: { status: 404, body: { error: "没有这个会话" } },
  });
});

test("malformed session and JSON responses share a category and recover", async () => {
  reply({ error: "not a session" });
  await expect(requestJSON("/session")).rejects.toMatchObject({ faultCode: "service_invalid_response" });
  globalThis.fetch = (async () => new Response("invalid JSON")) as unknown as typeof fetch;
  await expect(requestJSON("/health")).rejects.toMatchObject({ faultCode: "service_invalid_response" });
  const session = { conversationId: "cv_01", status: "idle", messages: [] };
  reply(session);
  await expect(requestJSON("/session")).resolves.toEqual(session);
});

test("non-JSON HTTP errors retain status and raw body; connection failures are distinct", async () => {
  globalThis.fetch = (async () => new Response("error", { status: 500 })) as unknown as typeof fetch;
  await expect(requestJSON("/turn")).rejects.toMatchObject({
    faultCode: "service_http_error", details: { status: 500, body: "error" },
  });
  globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
  await expect(requestJSON("/session")).rejects.toMatchObject({ faultCode: "service_unreachable", message: DOWN });
});

test("control timeout applies even when a caller signal is provided; turns only use caller signal", async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  const timeout = new AbortController();
  AbortSignal.timeout = () => timeout.signal;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    signals.push(init?.signal);
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  const caller = new AbortController();
  await requestJSON("/health", { signal: caller.signal });
  await requestJSON("/turn", { signal: caller.signal });
  await requestJSON("/turn");
  expect(signals[0]).not.toBe(caller.signal);
  expect(signals[1]).toBe(caller.signal);
  expect(signals[2]).toBeUndefined();
  timeout.abort(new DOMException("Timed out", "TimeoutError"));
  expect(signals[0]?.aborted).toBe(true);
  expect(caller.signal.aborted).toBe(false);
  await expect(requestJSON("/health", { signal: caller.signal })).rejects.toMatchObject({ faultCode: "service_timeout" });
  caller.abort();
  await expect(requestJSON("/health", { signal: caller.signal })).rejects.toMatchObject({ faultCode: "service_cancelled" });
});

test("caller cancellation aborts a pending control request", async () => {
  const caller = new AbortController();
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  })) as unknown as typeof fetch;
  const request = requestJSON("/health", { signal: caller.signal });
  caller.abort();
  await expect(request).rejects.toMatchObject({ faultCode: "service_cancelled" });
});

test("body reading classifies timeout, cancellation, and connection failure", async () => {
  for (const [name, code] of [["TimeoutError", "service_timeout"], ["AbortError", "service_cancelled"], ["TypeError", "service_unreachable"]]) {
    globalThis.fetch = (async () => ({
      text: async () => { throw new DOMException("read failed", name); },
    })) as unknown as typeof fetch;
    await expect(requestJSON("/health")).rejects.toMatchObject({ faultCode: code });
  }
});
