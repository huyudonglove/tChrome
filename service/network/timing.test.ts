import { describe, expect, test } from 'bun:test';
import { beginNetworkTiming, withNetworkTiming } from './timing.ts';
import { fetchWithIdleTimeout } from './timed-fetch.ts';

describe('network timing', () => {
  test('isolates concurrent scopes and numbers attempts without exposing request data', async () => {
    const first: Record<string, unknown>[] = [];
    const second: Record<string, unknown>[] = [];
    await Promise.all([
      withNetworkTiming(event => first.push(event), async () => {
        beginNetworkTiming('https://secret.invalid/?token=private', { body: '你好' })?.complete();
        await Bun.sleep(5);
        beginNetworkTiming('https://secret.invalid')?.error('transport');
      }),
      withNetworkTiming(event => second.push(event), async () => {
        await Bun.sleep(1);
        beginNetworkTiming('https://secret.invalid')?.complete();
      }),
    ]);
    expect(first.map(event => event.attempt)).toEqual([1, 1, 2, 2]);
    expect(second.map(event => event.attempt)).toEqual([1, 1]);
    expect(first[0]!.requestBytes).toBe(6);
    expect(first[0]!.uploadCompleteMs).toBeNull();
    expect(JSON.stringify(first)).not.toContain('secret');
    expect(beginNetworkTiming('https://unused.invalid')).toBeUndefined();
    expect(() => withNetworkTiming(() => { throw new Error('observer'); }, () =>
      beginNetworkTiming('https://unused.invalid')?.complete())).not.toThrow();
  });

  test('records delayed headers, first bytes and completion with cumulative bytes', async () => {
    const events: Record<string, unknown>[] = [];
    const server = Bun.serve({ port: 0, async fetch() {
      await Bun.sleep(25);
      return new Response(new ReadableStream({ async start(controller) {
        await Bun.sleep(25);
        controller.enqueue(new TextEncoder().encode('你好'));
        await Bun.sleep(25);
        controller.enqueue(new TextEncoder().encode('!'));
        controller.close();
      } }));
    } });
    try {
      await withNetworkTiming(event => events.push(event), async () => {
        const response = await fetchWithIdleTimeout(server.url, { method: 'POST', body: '输入' });
        expect(await response.text()).toBe('你好!');
      });
      expect(events.map(event => event.stage)).toEqual(['start', 'headers', 'first-body', 'complete']);
      const last = events.at(-1)!;
      expect(last.requestBytes).toBe(6);
      expect(last.responseBytes).toBe(7);
      expect(last.status).toBe(200);
      expect(Number(last.headersMs)).toBeGreaterThanOrEqual(20);
      expect(Number(last.firstBodyMs)).toBeGreaterThanOrEqual(Number(last.headersMs));
      expect(Number(last.elapsedMs)).toBeGreaterThan(Number(last.firstBodyMs));
    } finally { await server.stop(true); }
  });

  test('records one terminal event for timeout, upstream abort and consumer cancellation', async () => {
    const server = Bun.serve({ port: 0, fetch() {
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array([1]));
      } }));
    } });
    try {
      for (const mode of ['timeout', 'abort', 'consumer']) {
        const events: Record<string, unknown>[] = [];
        await withNetworkTiming(event => events.push(event), async () => {
          const abort = new AbortController();
          const response = await fetchWithIdleTimeout(server.url, { signal: abort.signal }, { idleTimeoutMs: 35 });
          const reader = response.body!.getReader();
          await reader.read();
          if (mode === 'consumer') await reader.cancel('private reason');
          else {
            const pending = reader.read();
            if (mode === 'abort') abort.abort(new Error('private reason'));
            await expect(pending).rejects.toThrow();
          }
        });
        expect(events.filter(event => ['complete', 'error', 'cancel'].includes(String(event.stage))).map(event => event.stage))
          .toEqual([mode === 'timeout' ? 'error' : 'cancel']);
        expect(JSON.stringify(events)).not.toContain('private reason');
      }
    } finally { await server.stop(true); }
  });
});
