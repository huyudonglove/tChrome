import { afterEach, describe, expect, test } from 'bun:test';
import { fetchWithIdleTimeout, HttpIdleTimeoutError } from './idle-fetch.ts';

const servers: ReturnType<typeof Bun.serve>[] = [];
const timers: ReturnType<typeof setInterval>[] = [];
const encoder = new TextEncoder();

function serve(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch });
  servers.push(server);
  return server.url;
}

afterEach(async () => {
  for (const timer of timers.splice(0)) clearInterval(timer);
  await Promise.all(servers.splice(0).map(server => server.stop(true)));
});

describe('fetchWithIdleTimeout', () => {
  test('times out while waiting for headers', async () => {
    const url = serve(async () => {
      await Bun.sleep(150);
      return new Response('late');
    });
    await expect(fetchWithIdleTimeout(url, undefined, { idleTimeoutMs: 35 }))
      .rejects.toBeInstanceOf(HttpIdleTimeoutError);
  });

  test('times out when a streamed body stops producing data', async () => {
    const url = serve(() => new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode('first')); },
    })));
    const response = await fetchWithIdleTimeout(url, undefined, { idleTimeoutMs: 60 });
    await expect(response.text()).rejects.toBeInstanceOf(HttpIdleTimeoutError);
  });

  test('allows active streaming beyond the inactivity interval and preserves metadata', async () => {
    const url = serve(request => {
      if (new URL(request.url).pathname === '/') return Response.redirect(new URL('/stream', request.url));
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('0'));
          let count = 0;
          const timer = setInterval(() => {
            controller.enqueue(encoder.encode(String(++count)));
            if (count === 8) {
              clearInterval(timer);
              controller.close();
            }
          }, 25);
          timers.push(timer);
        },
      }), { status: 201, headers: { 'x-stream': 'yes' } });
    });
    const start = Date.now();
    const response = await fetchWithIdleTimeout(url, undefined, { idleTimeoutMs: 90 });
    expect(response.status).toBe(201);
    expect(response.headers.get('x-stream')).toBe('yes');
    expect(response.url).toBe(new URL('/stream', url).href);
    expect(response.redirected).toBe(true);
    expect(await response.text()).toBe('012345678');
    expect(Date.now() - start).toBeGreaterThan(90);
    // A completed response remains usable after its former deadline.
    await Bun.sleep(110);
    expect(response.bodyUsed).toBe(true);
  });

  test('external abort cancels a pending body read with the original reason', async () => {
    const url = serve(() => new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode('first')); },
    })));
    const abort = new AbortController();
    const response = await fetchWithIdleTimeout(url, { signal: abort.signal }, { idleTimeoutMs: 90 });
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(encoder.encode('first'));
    const pending = reader.read();
    const reason = new DOMException('User stopped', 'AbortError');
    abort.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await Bun.sleep(110);
    await expect(reader.read()).rejects.toBe(reason);
  });

  test('honors Request signals and rejects an already canceled request', async () => {
    const abort = new AbortController();
    abort.abort(new Error('already stopped'));
    const request = new Request('http://localhost:1', { signal: abort.signal });
    await expect(fetchWithIdleTimeout(request)).rejects.toBe(abort.signal.reason);
  });

  test('consumer cancellation clears the deadline and leaves the stream closed', async () => {
    const url = serve(() => new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode('first')); },
    })));
    const response = await fetchWithIdleTimeout(url, undefined, { idleTimeoutMs: 60 });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel('enough');
    await Bun.sleep(90);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });
});
