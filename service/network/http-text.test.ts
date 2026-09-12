import { afterEach, expect, spyOn, test } from "bun:test";
import { fetchText } from "./http-text.ts";
import { HttpIdleTimeoutError } from "./idle-fetch.ts";
import { runServiceTool } from "../tools/service-tools.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function serve(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch });
  servers.push(server);
  return server.url.toString();
}

const policy = { idleTimeoutMs: 60, maxAttempts: 3, retryDelayMs: 1 };
const stalled = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("hello")); } }));

test("an inactive response stops after three total attempts", async () => {
  let requests = 0;
  const url = serve(() => { requests++; return stalled(); });
  await expect(fetchText(url, {}, 10, policy)).rejects.toBeInstanceOf(HttpIdleTimeoutError);
  expect(requests).toBe(3);
});

test("an idle first response can be retried successfully", async () => {
  let requests = 0;
  const url = serve(() => ++requests === 1 ? stalled() : new Response("recovered"));
  const result = await fetchText(url, {}, 20, policy);
  expect(result.text).toBe("recovered");
  expect(result.attempts).toBe(2);
});

test("continuous chunks keep a long transfer active even after the preview is full", async () => {
  let sent = 0;
  let cancelled = false;
  const url = serve(() => new Response(new ReadableStream({
    async pull(controller) {
      await Bun.sleep(20);
      controller.enqueue(new TextEncoder().encode("中文"));
      if (++sent === 10) controller.close();
    },
    cancel() { cancelled = true; },
  })));
  const result = await fetchText(url, {}, 3, { ...policy, idleTimeoutMs: 100 });
  expect(result.text).toBe("中文中");
  expect(result.truncated).toBe(true);
  expect(result.attempts).toBe(1);
  expect(result.ms).toBeGreaterThan(100);
  expect(sent).toBe(10);
  expect(cancelled).toBe(false);
});

test("caller cancellation never retries an active request", async () => {
  let requests = 0;
  const controller = new AbortController();
  const url = serve(() => { requests++; setTimeout(() => controller.abort(), 10); return stalled(); });
  await expect(fetchText(url, { signal: controller.signal }, 10, policy)).rejects.toThrow();
  await Bun.sleep(80);
  expect(requests).toBe(1);
});

test("caller cancellation interrupts the retry delay", async () => {
  let requests = 0;
  const controller = new AbortController();
  const url = serve(() => { requests++; return stalled(); });
  const pending = fetchText(url, { signal: controller.signal }, 10, { ...policy, retryDelayMs: 1000 });
  setTimeout(() => controller.abort(), 120);
  await expect(pending).rejects.toThrow();
  expect(requests).toBe(1);
});

test("HTTP failures preserve status without transport retries", async () => {
  let requests = 0;
  const url = serve(() => { requests++; return new Response("unavailable", { status: 503 }); });
  const result = await fetchText(url, {}, 20, policy);
  expect(result.ok).toBe(false);
  expect(result.status).toBe(503);
  expect(result.attempts).toBe(1);
  expect(requests).toBe(1);
});

test("HTTP batch cancellation prevents subsequent URLs from starting", async () => {
  let requests = 0;
  const controller = new AbortController();
  const url = serve(() => { requests++; setTimeout(() => controller.abort(), 10); return stalled(); });
  await expect(runServiceTool("/tmp", "send_http_batch", { urls: [url, url] }, controller.signal)).rejects.toThrow();
  expect(requests).toBe(1);
});

test("network disconnect retries and UTF-8 bytes crossing chunks decode correctly", async () => {
  const bytes = new TextEncoder().encode("中文");
  let requests = 0;
  const mock = spyOn(globalThis, "fetch").mockImplementation((async () => {
    if (++requests === 1) throw new TypeError("connection reset");
    let offset = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(bytes.slice(offset, ++offset));
        if (offset === bytes.length) controller.close();
      },
    }));
  }) as unknown as typeof fetch);
  try {
    const result = await fetchText("http://example.test/", {}, 20, policy);
    expect(result.text).toBe("中文");
    expect(result.truncated).toBe(false);
    expect(result.attempts).toBe(2);
  } finally {
    mock.mockRestore();
  }
});
