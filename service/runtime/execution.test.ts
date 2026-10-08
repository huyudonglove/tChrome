import { expect, test } from "bun:test";
import { beginExecution, cancelExecution, cancelAllExecutions } from "./execution.ts";
import type { CompletionResult, Provider } from "../types.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchWithIdleTimeout } from "../network/timed-fetch.ts";

test("execution persists correlated network attempts without request content", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "provider-timing-"));
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const provider: Provider = { complete: async () => {
    for (let i = 0; i < 2; i++) {
      const response = await fetchWithIdleTimeout(`http://127.0.0.1:${server.port}/?key=secret-query`, {
        method: "POST", headers: { authorization: "Bearer secret-token" }, body: "私密正文",
      });
      await response.text();
    }
    return result;
  } };
  const execution = beginExecution(dataDir, "cv_01", "tn_01", provider);
  try {
    await Promise.all([execution.provider.complete(input), execution.provider.complete(input)]);
    const text = readFileSync(join(dataDir, "conversations/cv_01/events.jsonl"), "utf8");
    const events = text.trim().split("\n").map(line => JSON.parse(line));
    const network = events.filter(event => event.kind === "provider-network" && event.data.stage === "complete");
    expect(network).toHaveLength(4);
    expect(new Set(network.map(event => event.data.requestId)).size).toBe(2);
    for (const requestId of new Set(network.map(event => event.data.requestId))) {
      expect(network.filter(event => event.data.requestId === requestId).map(event => event.data.attempt)).toEqual([1, 2]);
    }
    expect(network.every(event => event.turnId === "tn_01")).toBe(true);
    const outbound = events.filter(event => event.kind === "provider-outbound");
    expect(outbound).toHaveLength(4);
    for (const event of outbound) {
      const snapshotText = readFileSync(event.data.path, "utf8");
      const snapshot = JSON.parse(snapshotText);
      expect(snapshot).toMatchObject({ conversationId: "cv_01", turnId: "tn_01", requestId: event.data.requestId,
        attempt: event.data.attempt, method: "POST", body: "私密正文" });
      expect(snapshotText).not.toContain("secret-query");
      expect(snapshotText).not.toContain("secret-token");
    }
    expect(text).not.toContain("secret-query");
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("私密正文");
  } finally { execution.finish(); server.stop(true); rmSync(dataDir, { recursive: true, force: true }); }
});

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
