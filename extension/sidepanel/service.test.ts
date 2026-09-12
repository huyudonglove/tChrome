import { test, expect, afterEach } from "bun:test";
import { requestJSON, DOWN } from "./service";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const reply = (body: unknown, status = 200) => {
  globalThis.fetch = (async () => Response.json(body, { status })) as unknown as typeof fetch;
};

test("turn failure preserves the server error instead of swallowing it", async () => {
  reply({ error: "catalog unavailable" }, 500);
  await expect(requestJSON("/turn", { method: "POST" })).rejects.toThrow("失败：catalog unavailable");
  reply({ output: { kind: "error", faultCode: "conversation_changed" } }, 409);
  await expect(requestJSON("/turn")).rejects.toThrow("conversation_changed");
});

test("failed switch is rejected before its error body can become the session", async () => {
  reply({ error: "没有这个会话" }, 404);
  await expect(requestJSON("/conversations/open")).rejects.toThrow("没有这个会话");
});

test("session refresh rejects HTTP errors and malformed success responses, then recovers", async () => {
  reply({ error: "temporary failure" }, 500);
  await expect(requestJSON("/session")).rejects.toThrow("temporary failure");
  reply({ error: "not a session" });
  await expect(requestJSON("/session")).rejects.toThrow("无效的会话状态");
  const session = { conversationId: "cv_01", status: "idle", messages: [] };
  reply(session);
  await expect(requestJSON("/session")).resolves.toEqual(session);
});

test("non-JSON errors include HTTP status and network errors are explicit", async () => {
  globalThis.fetch = (async () => new Response("error", { status: 500 })) as unknown as typeof fetch;
  await expect(requestJSON("/turn")).rejects.toThrow("HTTP 500");
  globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  await expect(requestJSON("/session")).rejects.toThrow(DOWN);
});

test("control requests are bounded, long-running turns have no short timeout", async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    signals.push(init?.signal);
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  await expect(requestJSON("/health")).resolves.toEqual({ ok: true });
  await requestJSON("/conversations");
  await requestJSON("/turn");
  expect(signals[0]).toBeInstanceOf(AbortSignal);
  expect(signals[1]).toBeInstanceOf(AbortSignal);
  expect(signals[2]).toBeUndefined();
});
