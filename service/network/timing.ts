import { AsyncLocalStorage } from 'node:async_hooks';

export type OutboundRequest = { attempt: number; method: string; endpoint: string; body: string };
type TimingContext = { emit: (event: Record<string, unknown>) => void; attempt: number; capture?: (request: OutboundRequest) => void };
const timingContext = new AsyncLocalStorage<TimingContext>();

/** Scope network observations to one model invocation, including its retries. */
export function withNetworkTiming<T>(emit: TimingContext['emit'], run: () => T, capture?: TimingContext['capture']): T {
  return timingContext.run({ emit, attempt: 0, capture }, run);
}

function requestBytes(body: BodyInit | null | undefined): number | null {
  if (body == null) return 0;
  if (typeof body === 'string') return Buffer.byteLength(body, 'utf8');
  if (body instanceof URLSearchParams) return Buffer.byteLength(body.toString(), 'utf8');
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
  return null;
}

/** Fetch cannot expose socket upload completion or DNS/TCP/TLS timings. */
export function beginNetworkTiming(input: RequestInfo | URL, init?: RequestInit) {
  const context = timingContext.getStore();
  if (!context) return undefined;
  const attempt = ++context.attempt;
  if (context.capture) {
    try {
      const url = new URL(input instanceof Request ? input.url : String(input));
      // Providers serialize JSON before fetch. Keep that exact wire body, without
      // persisting headers, URL credentials or authentication query parameters.
      const body = init?.body ?? (input instanceof Request && input.body ? input.body : "");
      if (typeof body !== 'string') throw new Error('unsupported_body');
      context.capture({ attempt, method: init?.method ?? (input instanceof Request ? input.method : 'GET'), endpoint: `${url.origin}${url.pathname}`, body });
    } catch {
      try { context.emit({ stage: 'request-log-error', attempt, errorKind: 'snapshot_unavailable' }); } catch { /* Diagnostics only. */ }
    }
  }
  const start = performance.now();
  const startedAt = new Date().toISOString();
  const bytes = init?.body != null ? requestBytes(init.body)
    : input instanceof Request && input.body ? null : 0;
  let responseBytes = 0;
  let status: number | null = null;
  let headersMs: number | null = null;
  let firstBodyMs: number | null = null;
  function emit(stage: string, errorKind?: string) {
    const elapsedMs = performance.now() - start;
    if (stage === 'headers') headersMs = elapsedMs;
    if (stage === 'first-body') firstBodyMs = elapsedMs;
    try {
      context!.emit({
        stage, attempt, startedAt, elapsedMs, requestBytes: bytes, responseBytes,
        status, headersMs, firstBodyMs, uploadCompleteMs: null,
        timingLimit: 'fetch_does_not_expose_upload_dns_connect_tls',
        ...(errorKind ? { errorKind } : {}),
      });
    } catch { /* Telemetry must never change request behavior. */ }
  }
  emit('start');
  return {
    headers(value: number) { status = value; emit('headers'); },
    chunk(size: number) {
      responseBytes += size;
      if (firstBodyMs === null) emit('first-body');
    },
    complete() { emit('complete'); },
    error(kind: string) { emit('error', kind); },
    cancel() { emit('cancel'); },
  };
}
