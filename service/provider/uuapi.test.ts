import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProvider } from "./uuapi.ts";
import { handleTurn } from "../runtime/loop.ts";
import { loadLedger } from "../runtime/store.ts";

const input = { messages: [], tools: [], baseToolsIds: [], toolIds: [] };
const providerFor = (port: number) => createProvider({ apiKey: "local-test", baseURL: `http://127.0.0.1:${port}/v1`, proxy: "" });
const call = (id: string, name: string, args: string) => ({ id, type: "function", function: { name, arguments: args } });
const sse = (calls: ReturnType<typeof call>[], content = "") => new Response(
  `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content, tool_calls: calls.map((item, index) => ({ ...item, index })) }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
  { headers: { "Content-Type": "text/event-stream" } },
);

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
    ]) : sse([call("done", "finishTurn", '{"reason":"done","affectsPage":false,"text":"完成"}')], "seen\n测试完成\nreason\n收口\naction\n完成");
  } });
  try {
    const result = await handleTurn({ dataDir: dir, repoRoot: resolve(import.meta.dir, "../.."), provider: providerFor(server.port!) }, { userInput: "测试", submittedAt: "2026-09-08T00:00:00.000Z" });
    expect(result.output).toEqual({ kind: "reply", text: "完成" });
    const ledger = loadLedger(dir, "cv_01");
    expect(ledger.notes.kept).toBe("yes");
    expect(ledger.toolIO.map((item) => item.callId)).toEqual(["broken_1", "broken_2", "missing", "valid", "done"]);
    expect(requests).toBe(2);
  } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});
