import { expect, test } from "bun:test";
import { beginExecution, cancelExecution, cancelAllExecutions } from "./execution.ts";
import type { CompletionResult, Provider } from "../types.ts";

const input = { messages: [], tools: [] };
const result: CompletionResult = { content: "", toolCalls: [], finish: "stop", attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [] };

test("execution supplies its conversation identity across turns and concurrent requests", async () => {
  const seen: Array<{ conversationId?: string; signal?: AbortSignal }> = [];
  const provider: Provider = { complete: async request => {
    seen.push({ conversationId: request.conversationId, signal: request.signal });
    await Promise.resolve();
    return result;
  } };
  const first = beginExecution("/tmp/execution-session", "cv_01", "tn_01", provider);
  try {
    await first.provider.complete(input);
  } finally { first.finish(); }
  const next = beginExecution("/tmp/execution-session", "cv_01", "tn_02", provider);
  const other = beginExecution("/tmp/execution-session", "cv_02", "tn_03", provider);
  try {
    await Promise.all([
      next.provider.complete({ ...input, conversationId: "cv_wrong" }),
      other.provider.complete(input),
      next.provider.complete(input),
    ]);
    expect(seen.map(request => request.conversationId)).toEqual(["cv_01", "cv_01", "cv_02", "cv_01"]);
    expect(seen[1]!.signal).toBe(next.signal);
    expect(seen[2]!.signal).toBe(other.signal);
    expect(seen[3]!.signal).toBe(next.signal);
  } finally { next.finish(); other.finish(); }
});

test("execution terminal states are irreversible and reject further requests", async () => {
  let calls = 0;
  const provider: Provider = { complete: async () => { calls++; return result; } };
  const done = beginExecution("/tmp/execution-state", "cv_01", "tn_01", provider);
  expect(done.state).toBe("active");
  expect(await done.provider.complete(input)).toEqual(result);
  done.finish(); done.cancel(); done.finish();
  expect(done.state).toBe("finished");
  expect((await done.provider.complete(input)).faultCode).toBe("stopped");
  const cancelled = beginExecution("/tmp/execution-state", "cv_01", "tn_02", provider);
  cancelled.cancel(); cancelled.cancel(); cancelled.finish();
  expect(cancelled.state).toBe("cancelled");
  expect(cancelled.signal.aborted).toBe(true);
  expect((await cancelled.provider.complete(input)).faultCode).toBe("stopped");
  expect(calls).toBe(1);
});

test("finishing a replaced execution cannot unregister its replacement", () => {
  const provider: Provider = { complete: async () => result };
  const old = beginExecution("/tmp/execution-owner", "cv_01", "tn_01", provider);
  const next = beginExecution("/tmp/execution-owner", "cv_01", "tn_02", provider);
  try {
    expect(old.state).toBe("cancelled");
    old.finish();
    expect(next.state).toBe("active");
    cancelExecution("/tmp/execution-owner", "cv_01");
    expect(next.state).toBe("cancelled");
  } finally { next.finish(); }
});

test("shutdown cancellation is scoped by service data directory", async () => {
  const provider: Provider = { complete: () => new Promise(() => {}) };
  const left = beginExecution("/tmp/execution-left", "cv_01", "tn_01", provider);
  const right = beginExecution("/tmp/execution-right", "cv_01", "tn_01", provider);
  const pending = left.provider.complete(input);
  try {
    cancelAllExecutions("/tmp/execution-left");
    expect((await pending).faultCode).toBe("stopped");
    expect(left.state).toBe("cancelled");
    expect(right.state).toBe("active");
  } finally { left.finish(); right.finish(); }
});
