import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProvider } from "./uuapi.ts";
import { sseResponse } from "./sse.ts";
import { runtimeConfig } from "../config/runtime.ts";
import { handleTurn } from "../runtime/loop.ts";
import { loadLedger, loadProviderLog } from "../runtime/store.ts";

const input = { messages: [], tools: [] };
const providerFor = (port: number) => createProvider({ apiKey: "local-test", baseURL: `http://127.0.0.1:${port}/v1`, proxy: "" });
const call = (id: string, name: string, args: string) => ({ id, type: "function", function: { name, arguments: args } });
const sse = (calls: ReturnType<typeof call>[], content = "", finish = "tool_calls") => {
  const events: unknown[] = [];
  if (content) events.push({ choices: [{ index: 0, delta: { content } }] });
  for (const [index, toolCall] of calls.entries()) {
    events.push({
      choices: [{ index: 0, delta: { tool_calls: [{ index, id: toolCall.id, function: { name: toolCall.function.name, arguments: toolCall.function.arguments } }] } }],
    });
  }
  events.push({ choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  return sseResponse(events);
};

for (const finish of ["length", "content_filter", "stop", "unknown"]) {
  const faultCode = finish === "length" ? "provider_output_limit" : finish === "content_filter" ? "provider_refused" : "provider_invalid_response";
  const retriedInvalid = faultCode === "provider_invalid_response";
  test(`${finish} 工具批次整批拒绝，合法兄弟不执行`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "tchrome-provider-finish-"));
    let requests = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      requests++;
      return sse([
        call("valid", "notes.write", '{"reason":"test","key":"kept","value":"yes"}'),
        call("broken", "notes.write", '{"reason":"test"'),
      ], "partial", finish);
    } });
    try {
      const provider = providerFor(server.port!);
      const response = await provider.complete(input);
      expect(response.finish).toBe("error");
      expect(response.faultCode).toBe(faultCode);
      expect(response.toolCalls).toEqual([]);
      expect(response.toolCallFaults).toBeUndefined();
      const retriedInvalid = faultCode === "provider_invalid_response";
      expect(response.attempts).toBe(retriedInvalid ? runtimeConfig.network.maxAttempts : 1);
      const result = await handleTurn({ dataDir: dir, repoRoot: resolve(import.meta.dir, "../.."), provider },
        { userInput: "测试", submittedAt: "now" });
      const detailSuffix = finish === "length" ? "chat_output_limit"
        : finish === "content_filter" ? "chat_content_refused"
        : finish === "stop" ? "chat_stop_with_tool_calls"
        : `chat_unexpected_finish: ${finish}`;
      expect(result.output).toEqual({ kind: "error", faultCode, detail: `status=0; ${detailSuffix}` });
      const ledger = loadLedger(dir, result.conversationId);
      expect(ledger.notes.kept).toBeUndefined();
      expect(ledger.toolIO).toEqual([]);
      // complete() retries invalid responses; handleTurn issues another provider request.
      expect(requests).toBe(retriedInvalid ? runtimeConfig.network.maxAttempts * 2 : 2);
    } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
  }, retriedInvalid ? 60_000 : 15_000);
}

test("正常 stop 文本响应保持成功", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => sse([], "完成", "stop") });
  try {
    const result = await providerFor(server.port!).complete(input);
    expect(result.finish).toBe("stop");
    expect(result.content).toBe("完成");
    expect(result.faultCode).toBeNull();
    expect(result.toolCalls).toEqual([]);
  } finally { server.stop(true); }
});

test("tool_choice required 被拒后降级 auto 重试且不消耗 attempts", async () => {
  let requests = 0;
  const bodies: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests++;
    const body = await request.json();
    bodies.push(body);
    if (body.tool_choice === "required") {
      return Response.json({ error: { message: "Invalid 'tool_choice': thinking mode does not support required", type: "invalid_request_error" } }, { status: 400 });
    }
    return sse([call("c1", "finishTurn", '{"text":"好"}')]);
  } });
  try {
    const result = await providerFor(server.port!).complete({ ...input, toolChoice: "required" });
    expect(requests).toBe(2);
    expect(bodies[0]!.tool_choice).toBe("required");
    expect(bodies[1]!.tool_choice).toBeUndefined();
    expect(result.attempts).toBe(1);
    expect(result.finish).toBe("tool_calls");
    expect(result.toolCalls[0]?.name).toBe("finishTurn");
  } finally { server.stop(true); }
});

for (const status of [500, 429, 401, 400]) {
  const retried = status >= 500 || status === 429;
  test(`HTTP ${status} 实际请求数与 attempts 一致`, async () => {
    let requests = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      requests++;
      return Response.json({ error: { message: "local test" } }, { status });
    } });
    try {
      const result = await providerFor(server.port!).complete(input);
      expect(requests).toBe(retried ? runtimeConfig.network.maxAttempts : 1);
      expect(result.attempts).toBe(requests);
      expect(result.faultCode).toBe(status === 401 ? "provider_key_invalid" : "provider_error");
    } finally { server.stop(true); }
  }, retried ? 30_000 : 10_000);
}

for (const badIndex of [0, 1, 2]) {
  test(`坏参数位于 ${badIndex} 时保留其余工具顺序`, async () => {
    const calls = [0, 1, 2].map((i) => call(`call_${i}`, "notes.write", i === badIndex ? "{broken" : '{"reason":"test","key":"k","value":"v"}'));
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => sse(calls) });
    try {
      const result = await providerFor(server.port!).complete(input);
      expect(result.toolCalls.map((item) => item.id)).toEqual(calls.filter((_, i) => i !== badIndex).map((item) => item.id));
      expect(result.toolCallFaults?.map((item) => item.callId)).toEqual([`call_${badIndex}`]);
      expect(result.parseOk).toBe(false);
    } finally { server.stop(true); }
  });
}

test("真实 Provider 到 Runtime：多个坏调用留账，合法兄弟照跑", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-provider-"));
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    requests++;
    return requests === 1 ? sse([
      call("broken_1", "notes.write", "{broken"),
      call("missing", "notes.write", '{"reason":"test"}'),
      call("valid", "notes.write", '{"reason":"test","key":"kept","value":"yes"}'),
      call("broken_2", "notes.write", "{broken"),
    ]) : sse([call("done", "finishTurn", '{"reason":"done","text":"完成"}')]);
  } });
  try {
    const result = await handleTurn({ dataDir: dir, repoRoot: resolve(import.meta.dir, "../.."), provider: providerFor(server.port!) }, { userInput: "测试", submittedAt: "2026-09-08T00:00:00.000Z" });
    expect(result.output).toEqual({ kind: "reply", text: "完成" });
    const ledger = loadLedger(dir, "cv_01");
    expect(ledger.notes.kept).toBe("yes");
    expect(ledger.toolIO.map((item) => item.callId)).toEqual(["call_03", "call_04", "call_01", "call_02", "call_05"]);
    expect(loadProviderLog(dir, "cv_01")[0]!.response.providerCallIds).toEqual({ call_01: "missing", call_02: "valid", call_03: "broken_1", call_04: "broken_2" });
    expect(requests).toBe(2);
  } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("provider returns parsed calls without enforcing runtime tool policy", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => sse([
    call("unknown", "not_registered", "{}"),
  ]) });
  try {
    const result = await providerFor(server.port!).complete(input);
    expect(result.parseOk).toBe(true);
    expect(result.toolCalls[0]?.name).toBe("not_registered");
    expect(result.faultCode).toBeNull();
  } finally { server.stop(true); }
});

for (const policy of ["unknown_tool", "missing_required", "exclusive_resident"]) {
  test(`runtime enforces ${policy} for normally parsed provider responses`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "tchrome-runtime-policy-"));
    let requests = 0;
    const valid = call("valid", "notes.write", JSON.stringify({ reason: "test", key: "kept", value: "yes" }));
    const done = call("done", "finishTurn", JSON.stringify({ reason: "done", text: "完成" }));
    const bad = policy === "exclusive_resident" ? done : call("invalid", policy === "unknown_tool" ? "not_registered" : "notes.write", "{}");
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => sse(++requests === 1 ? [bad, valid] : [done]) });
    try {
      const reply = await handleTurn({ dataDir: dir, repoRoot: resolve(import.meta.dir, "../.."), provider: providerFor(server.port!) },
        { userInput: "测试", submittedAt: "now" });
      expect(reply.output).toEqual({ kind: "reply", text: "完成" });
      const ledger = loadLedger(dir, reply.conversationId);
      expect(ledger.notes.kept).toBe(policy === "exclusive_resident" ? undefined : "yes");
      expect(ledger.toolIO.some((row) => row.return.text.includes(policy))).toBe(true);
    expect(requests).toBe(2);
    } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
  });
}
