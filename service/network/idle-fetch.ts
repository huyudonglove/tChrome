import { runtimeConfig } from '../config/runtime.ts';

/** No response activity was received during the configured interval. */
export class HttpIdleTimeoutError extends Error {
  constructor(readonly idleTimeoutMs: number) {
    super(`HTTP response was inactive for ${idleTimeoutMs} ms`);
    this.name = 'HttpIdleTimeoutError';
  }
}

/** Fetch with an inactivity deadline shared by headers and streamed body reads. */
export async function fetchWithIdleTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: { idleTimeoutMs?: number },
): Promise<Response> {
  const idleTimeoutMs = options?.idleTimeoutMs ?? runtimeConfig.network.idleTimeoutMs;
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new RangeError('idleTimeoutMs must be a positive finite number');
  }
  const upstreamSignal = init?.signal === undefined
    ? (input instanceof Request ? input.signal : undefined)
    : init.signal;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let finished = false;
  let failure: unknown;

  function cleanup() {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener('abort', onAbort);
  }
  function fail(reason: unknown) {
    if (finished) return;
    finished = true;
    failure = reason;
    cleanup();
    abort.abort(reason);
    stream?.error(reason);
    void reader?.cancel(reason).catch(() => {});
  }
  function onAbort() {
    fail(upstreamSignal?.reason ?? new DOMException('Request aborted', 'AbortError'));
  }
  function resetDeadline() {
    clearTimeout(timer);
    timer = setTimeout(() => fail(new HttpIdleTimeoutError(idleTimeoutMs)), idleTimeoutMs);
  }

  upstreamSignal?.addEventListener('abort', onAbort, { once: true });
  if (upstreamSignal?.aborted) onAbort();
  if (finished) throw failure;
  resetDeadline();
  try {
    const response = await fetch(input, { ...init, signal: abort.signal });
    if (finished) {
      void response.body?.cancel(failure).catch(() => {});
      throw failure;
    }
    if (!response.body) {
      finished = true;
      cleanup();
      return response;
    }
    resetDeadline();
    reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      },
      async pull(controller) {
        try {
          // Empty chunks do not count as activity.
          while (!finished) {
            const chunk = await reader!.read();
            if (finished) return;
            if (chunk.done) {
              finished = true;
              cleanup();
              controller.close();
              reader!.releaseLock();
              return;
            }
            if (chunk.value.byteLength > 0) {
              resetDeadline();
              controller.enqueue(chunk.value);
              return;
            }
          }
        } catch (error) {
          fail(error);
        }
      },
      async cancel(reason) {
        if (finished) return;
        finished = true;
        cleanup();
        abort.abort(reason);
        await reader!.cancel(reason).catch(() => {});
      },
    });
    const wrapped = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    // Response's constructor does not preserve fetch metadata.
    for (const key of ['url', 'redirected', 'type'] as const) {
      Object.defineProperty(wrapped, key, { value: response[key], enumerable: true });
    }
    return wrapped;
  } catch (error) {
    if (!finished) {
      finished = true;
      cleanup();
      abort.abort(error);
    }
    throw failure ?? error;
  }
}
