import { expect, test } from "bun:test";
import { createGeminiProvider } from "./gemini.ts";
import { providerApiKeyEnv, providerOptions } from "./config.ts";

const providerFor = (port: number, extra: { googleSearch?: boolean } = {}) =>
  createGeminiProvider({ apiKey: "local-test", baseURL: `http://127.0.0.1:${port}/v1beta`, proxy: "", ...extra });

const messages = [
  { role: "system" as const, content: "SYSTEM_RULES" },
  { role: "user" as const, content: "帮我查一下" },
];

const tools = [{
  type: "function" as const,
  function: {
    name: "notes.write",
    description: "保存工作笔记。",
    parameters: {
      type: "object",
      properties: { reason: { type: "string" }, key: { type: "string" }, value: { type: "string" } },
      required: ["reason", "key", "value"],
    },
  },
}];

const geminiBody = (body: unknown, status = 200) => Response.json(body, { status });

test("请求体包含 systemInstruction、google_search 与 functionDeclarations", async () => {
  let captured: any;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    captured = { url: request.url, headers: Object.fromEntries(request.headers), body: await request.json() };
    return geminiBody({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "好的" }] } }] });
  } });
  try {
    const result = await providerFor(server.port!).complete({ messages, tools });
    expect(result.finish).toBe("stop");
    expect(result.content).toBe("好的");
    expect(captured.url).toContain("/models/gemini-3.8-flash:generateContent");
    expect(captured.headers["x-goog-api-key"]).toBe("local-test");
    expect(captured.body.systemInstruction.parts[0].text).toBe("SYSTEM_RULES");
    expect(captured.body.contents).toEqual([{ role: "user", parts: [{ text: "帮我查一下" }] }]);
    expect(captured.body.tools[0]).toEqual({ google_search: {} });
    expect(captured.body.tools[1].functionDeclarations[0].name).toBe("notes.write");
    expect(captured.body.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } });
  } finally { server.stop(true); }
});

test("functionCall 生成稳定 call id 并解析参数", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => geminiBody({
    candidates: [{
      finishReason: "STOP",
      content: { parts: [
        { text: "先记一笔" },
        { functionCall: { name: "notes.write", args: { reason: "记录", key: "k", value: "v" } } },
        { functionCall: { name: "notes.write", args: { reason: "再记", key: "k2", value: "v2" } } },
      ] },
    }],
  }) });
  try {
    const result = await providerFor(server.port!).complete({ messages, tools });
    expect(result.finish).toBe("tool_calls");
    expect(result.toolCalls.map((call) => call.id)).toEqual(["gem_call_01", "gem_call_02"]);
    expect(result.toolCalls[0]).toEqual({
      id: "gem_call_01", name: "notes.write",
      arguments: { reason: "记录", key: "k", value: "v" },
    });
    expect(result.content).toBe("先记一笔");
  } finally { server.stop(true); }
});

test("缺 args 的 functionCall 解析为空对象并保留调用", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => geminiBody({
    candidates: [{
      finishReason: "STOP",
      content: { parts: [
        { functionCall: { name: "notes.write", args: { reason: "ok", key: "k", value: "v" } } },
        { functionCall: { name: "broken", args: undefined } },
      ] },
    }],
  }) });
  try {
    // args undefined → "{}" via JSON.stringify; use a name that still parses as object.
    const result = await providerFor(server.port!).complete({ messages, tools });
    expect(result.parseOk).toBe(true);
    expect(result.toolCalls.map((call) => call.name)).toEqual(["notes.write", "broken"]);
  } finally { server.stop(true); }
});

test("MAX_TOKENS 与 SAFETY 分别归为 output_limit 与 refused", async () => {
  for (const [finishReason, faultCode] of [["MAX_TOKENS", "provider_output_limit"], ["SAFETY", "provider_refused"]] as const) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => geminiBody({
      candidates: [{ finishReason, content: { parts: [{ text: "partial" }] } }],
    }) });
    try {
      const result = await providerFor(server.port!).complete({ messages, tools });
      expect(result.finish).toBe("error");
      expect(result.faultCode).toBe(faultCode);
      expect(result.attempts).toBe(1);
    } finally { server.stop(true); }
  }
});

test("grounding 作为独立字段返回，不混入 content 或 toolCalls", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => geminiBody({
    candidates: [{
      finishReason: "STOP",
      content: { parts: [{ text: "搜索结果摘要" }] },
      groundingMetadata: {
        webSearchQueries: ["gemini 3.8 flash"],
        groundingChunks: [{ web: { uri: "https://example.com/a", title: "Example" } }],
      },
    }],
  }) });
  try {
    const result = await providerFor(server.port!).complete({ messages, tools });
    expect(result.content).toBe("搜索结果摘要");
    expect(result.content).not.toContain("[google_search]");
    expect(result.toolCalls).toEqual([]);
    expect(result.grounding).toEqual({
      name: "google_search",
      queries: ["gemini 3.8 flash"],
      sources: [{ title: "Example", uri: "https://example.com/a" }],
    });
  } finally { server.stop(true); }
});

for (const status of [401, 429, 500]) {
  test(`HTTP ${status} 重试次数与 Chat/Responses 策略一致`, async () => {
    let requests = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      requests++;
      return geminiBody({ error: { message: "local test", code: status } }, status);
    } });
    try {
      const result = await providerFor(server.port!).complete({ messages, tools });
      expect(requests).toBe(status === 429 || status >= 500 ? 3 : 1);
      expect(result.attempts).toBe(requests);
      expect(result.faultCode).toBe(status === 401 ? "provider_key_invalid" : "provider_error");
    } finally { server.stop(true); }
  });
}

test("关闭 google_search 后 tools 仅剩 functionDeclarations", async () => {
  let captured: any;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    captured = await request.json();
    return geminiBody({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "ok" }] } }] });
  } });
  try {
    await providerFor(server.port!, { googleSearch: false }).complete({ messages, tools });
    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0].functionDeclarations).toBeDefined();
    expect(captured.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } });
  } finally { server.stop(true); }
});

test("providerOptions registers all gateways with key env mapping", () => {
  expect(providerOptions.map((item) => item.id)).toEqual([
    "uuapi", "shiningspace", "gemini", "deepseek", "caicai", "deepseek-official",
  ]);
  expect(providerApiKeyEnv.gemini).toBe("GEMINI_API_KEY");
  expect(providerApiKeyEnv.deepseek).toBe("DEEPSEEK_API_KEY");
  expect(providerApiKeyEnv.caicai).toBe("CAICAI_API_KEY");
  expect(providerApiKeyEnv["deepseek-official"]).toBe("DEEPSEEK_OFFICIAL_API_KEY");
});
