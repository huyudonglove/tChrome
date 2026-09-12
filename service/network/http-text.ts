import { setTimeout as sleep } from "node:timers/promises";
import { runtimeConfig } from "../config/runtime.ts";
import { fetchWithIdleTimeout, HttpIdleTimeoutError } from "./idle-fetch.ts";

export interface HttpTextPolicy {
  idleTimeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

/** Keep a bounded preview while draining the stream so active transfers can finish. */
export async function fetchText(
  url: string,
  init: RequestInit = {},
  textLimit: number = runtimeConfig.http.textLimit,
  policyOverrides: HttpTextPolicy = {},
) {
  const policy = { ...runtimeConfig.network, ...policyOverrides };
  const started = Date.now();
  for (let attempts = 1; ; attempts++) {
    init.signal?.throwIfAborted();
    try {
      const response = await fetchWithIdleTimeout(url, { redirect: "follow", ...init }, {
        idleTimeoutMs: policy.idleTimeoutMs,
      });
      // A zero preview is the headers-only probe contract, not a body transfer.
      if (textLimit === 0) await response.body?.cancel();
      const reader = textLimit === 0 ? undefined : response.body?.getReader();
      const decoder = new TextDecoder();
      let text = "";
      let truncated = false;
      const append = (chunk: string) => {
        const remaining = Math.max(0, textLimit - text.length);
        if (chunk.length > remaining) truncated = true;
        text += chunk.slice(0, remaining);
      };
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            append(decoder.decode(value, { stream: true }));
          }
          append(decoder.decode());
        } finally {
          reader.releaseLock();
        }
      }
      init.signal?.throwIfAborted();
      return {
        ok: response.ok,
        status: response.status,
        url: response.url,
        ms: Date.now() - started,
        headers: Object.fromEntries([...response.headers.entries()].slice(0, runtimeConfig.http.headerLimit)),
        text,
        attempts,
        truncated,
      };
    } catch (error) {
      init.signal?.throwIfAborted();
      if (attempts >= policy.maxAttempts || !(error instanceof HttpIdleTimeoutError || error instanceof TypeError)) {
        throw error;
      }
      await sleep(policy.retryDelayMs, undefined, { signal: init.signal ?? undefined });
    }
  }
}
