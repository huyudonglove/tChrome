import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProvider } from "./uuapi.ts";
import { handleTurn } from "../runtime/loop.ts";
import { loadLedger, loadProviderLog } from "../runtime/store.ts";

const input = { messages: [], tools: [] };
const providerFor = (port: number) => createProvider({ apiKey: "local-test", baseURL: `http://127.0.0.1:${port}/v1`, proxy: "" });
const call = (id: string, name: string, args: string) => ({ id, type: "function", function: { name, arguments: args } });
const sse = (calls: ReturnType<typeof call>[], content = "", finish = "tool_calls") => Response.json({
  id: "test", object: "chat.completion", choices: [{ index: 0,
    message: { role: "assistant", content, tool_calls: calls }, finish_reason: finish }],
});

for (const finish of ["length", "content_filter", "stop", "unknown"]) {
  const faultCode = finish === "length" ? "provider_output_limit" : finish === "content_filter" ? "provider_refused" : "provider_invalid_response";
  test(`${finish} 工具批次整批拒绝，合法兄弟不执行`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "tchrome-provider-finish-"));
    let requests = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      requests++;
      return sse([
        call("valid", "notes.write", '{"reason":"test","affectsPage":false,"key":"kept","value":"yes"}'),
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
      expect(response.attempts).toBe(1);
      const result = await handleTurn({ dataDir: dir, repoRoot: resolve(import.meta.dir, "../.."), provider },
        { userInput: "测试", submittedAt: "now" });
      expect(result.output).toEqual({ kind: "error", faultCode });
      const ledger = loadLedger(dir, result.conversationId);
      expect(ledger.notes.kept).toBeUndefined();
      expect(ledger.toolIO).toEqual([]);
      expect(requests).toBe(2);
    } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
  });
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

for (const status of [500, 429, 401, 400]) {
  test(`HTTP ${status} 实际请求数与 attempts 一致`, async () => {
    let requests = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      requests++;
      return Response.json({ error: { message: "local test" } }, { status });
    } });
    try {
      const result = await providerFor(server.port!).complete(input);
      expect(requests).toBe(status >= 500 || status === 429 ? 3 : 1);
      expect(result.attempts).toBe(requests);
      expect(result.faultCode).toBe(status === 401 ? "provider_key_invalid" : "provider_error");
    } finally { server.stop(true); }
  });
}

for (const badIndex of [0, 1, 2]) {
  test(`坏参数位于 ${badIndex} 时保留其余工具顺序`, async () => {
    const calls = [0, 1, 2].map((i) => call(`call_${i}`, "notes.write", i === badIndex ? "{broken" : '{"reason":"test","affectsPage":false,"key":"k","value":"v"}'));
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
      call("missing", "notes.write", '{"reason":"test","affectsPage":false}'),
      call("valid", "notes.write", '{"reason":"test","affectsPage":false,"key":"kept","value":"yes"}'),
      call("broken_2", "notes.write", "{broken"),
    ]) : sse([call("done", "finishTurn", '{"reason":"done","affectsPage":false,"text":"完成"}')]);
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
    const valid = call("valid", "notes.write", JSON.stringify({ reason: "test", affectsPage: false, key: "kept", value: "yes" }));
    const done = call("done", "finishTurn", JSON.stringify({ reason: "done", affectsPage: false, text: "完成" }));
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
