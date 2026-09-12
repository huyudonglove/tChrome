import { expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createProvider } from "./uuapi.ts";

const messages = [{ role: "user" as const, content: "test" }];
const expectedStopped = (attempts: number) => ({
  finish: "error", faultCode: "stopped", attempts, content: "", toolCalls: [],
});

for (const api of ["chat", "responses"] as const) {
  test(`${api}: pre-cancelled requests never reach the network`, async () => {
    let requests = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      requests++;
      return Response.json({});
    } });
    try {
      const controller = new AbortController();
      controller.abort();
      const provider = createProvider({ api, apiKey: "test", proxy: "", baseURL: `http://127.0.0.1:${server.port}/v1` });
      expect(await provider.complete({ messages, tools: [], signal: controller.signal })).toMatchObject(expectedStopped(0));
      expect(requests).toBe(0);
    } finally { server.stop(true); }
  });

  test(`${api}: cancellation aborts an in-flight request and discards late tool calls`, async () => {
    let requests = 0;
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      requests++;
      started.resolve();
      return response.promise;
    } });
    try {
      const controller = new AbortController();
      const provider = createProvider({ api, apiKey: "test", proxy: "", baseURL: `http://127.0.0.1:${server.port}/v1` });
      const pending = provider.complete({ messages, tools: [], signal: controller.signal });
      await started.promise;
      controller.abort();
      // The server has not responded: completion must be caused by network cancellation.
      expect(await pending).toMatchObject(expectedStopped(1));
      response.resolve(Response.json(api === "chat" ? {
        choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "late", type: "function", function: { name: "finishTurn", arguments: '{}' } }] } }],
      } : {
        status: "completed", output: [{ type: "function_call", call_id: "late", name: "finishTurn", arguments: '{}' }],
      }));
      expect(requests).toBe(1);
    } finally {
      response.resolve(new Response("closed"));
      server.stop(true);
    }
  });

  test(`${api}: cancellation interrupts retry backoff and prevents further requests`, async () => {
    let requests = 0;
    const failed = Promise.withResolvers<void>();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      requests++;
      failed.resolve();
      return Response.json({ error: { message: "retry me" } }, { status: 500 });
    } });
    try {
      const controller = new AbortController();
      const provider = createProvider({ api, apiKey: "test", proxy: "", baseURL: `http://127.0.0.1:${server.port}/v1` });
      const pending = provider.complete({ messages, tools: [], signal: controller.signal });
      await failed.promise;
      // Allow the SDK to consume the error and enter the 1-second retry wait.
      await sleep(100);
      const cancelledAt = performance.now();
      controller.abort();
      expect(await pending).toMatchObject(expectedStopped(1));
      expect(performance.now() - cancelledAt).toBeLessThan(500);
      expect(requests).toBe(1);
    } finally { server.stop(true); }
  });
}

test("pre-cancellation takes precedence over missing provider credentials", async () => {
  const controller = new AbortController();
  controller.abort();
  const provider = createProvider({ apiKey: "", proxy: "" });
  expect(await provider.complete({ messages, tools: [], signal: controller.signal })).toMatchObject(expectedStopped(0));
  expect(await provider.complete({ messages, tools: [] })).toMatchObject({ faultCode: "provider_key_missing", attempts: 0 });
});
