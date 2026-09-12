import { resolve } from "node:path";
import type { CompletionResult, Provider } from "../types.ts";

export type ExecutionState = "active" | "cancelled" | "finished";
const executions = new Map<string, Execution>();
const keyFor = (dataDir: string, conversationId: string) => JSON.stringify([resolve(dataDir), conversationId]);
const stopped = (): CompletionResult => ({
  finish: "error", content: "", toolCalls: [], attempts: 0,
  parseOk: false, schemaOk: false, faultCode: "stopped", missing: [],
});

/** One I/O lifecycle per turn, shared by main, compression and query requests.
 * active -> cancelled | finished; terminal executions can never issue requests again.
 * Ledger status remains the durable conversation state; this owns live cancellation.
 */
class Execution {
  private current: ExecutionState = "active";
  private readonly controller = new AbortController();
  readonly provider: Provider;
  get state() { return this.current; }
  get signal() { return this.controller.signal; }

  constructor(readonly dataDir: string, readonly conversationId: string, readonly turnId: string, source: Provider) {
    this.provider = { complete: input => {
      if (this.current !== "active") return Promise.resolve(stopped());
      const signal = input.signal ? AbortSignal.any([this.signal, input.signal]) : this.signal;
      if (signal.aborted) return Promise.resolve(stopped());
      // The transport receives the same signal. Racing it also releases callers of
      // injected providers that ignore cancellation, without accepting their late results.
      return new Promise<CompletionResult>((resolveRequest, reject) => {
        let settled = false;
        const settle = (complete: () => void) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          if (signal.aborted || this.current !== "active") resolveRequest(stopped());
          else complete();
        };
        const onAbort = () => settle(() => resolveRequest(stopped()));
        signal.addEventListener("abort", onAbort, { once: true });
        try { Promise.resolve(source.complete({ ...input, signal })).then(result => settle(() => resolveRequest(result)), error => settle(() => reject(error))); }
        catch (error) { settle(() => reject(error)); }
      });
    } };
  }

  cancel(): void {
    if (this.current !== "active") return;
    this.current = "cancelled";
    this.controller.abort(new DOMException("Turn stopped", "AbortError"));
  }

  finish(): void {
    if (this.current === "active") this.current = "finished";
    // Release pending listeners and prevent a completed turn from leaving I/O behind.
    if (!this.signal.aborted) this.controller.abort(new DOMException("Turn finished", "AbortError"));
    const key = keyFor(this.dataDir, this.conversationId);
    if (executions.get(key) === this) executions.delete(key);
  }
}

export function beginExecution(dataDir: string, conversationId: string, turnId: string, provider: Provider): Execution {
  const key = keyFor(dataDir, conversationId);
  executions.get(key)?.cancel();
  const execution = new Execution(resolve(dataDir), conversationId, turnId, provider);
  executions.set(key, execution);
  return execution;
}

export function cancelExecution(dataDir: string, conversationId: string): void {
  executions.get(keyFor(dataDir, conversationId))?.cancel();
}

export function cancelAllExecutions(dataDir?: string): void {
  for (const execution of executions.values()) {
    if (dataDir === undefined || execution.dataDir === resolve(dataDir)) execution.cancel();
  }
}
