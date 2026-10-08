import { fetchWithIdleTimeout as fetchIdle } from "./idle-fetch.ts";
import { beginNetworkTiming } from "./timing.ts";

/** Server-only provider transport. Browser callers use idle-fetch directly. */
export function fetchWithIdleTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: { idleTimeoutMs?: number },
): Promise<Response> {
  return fetchIdle(input, init, { ...options, timing: beginNetworkTiming(input, init) });
}
