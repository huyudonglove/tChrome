import { expect, test } from "bun:test";
import { createProvider } from "./uuapi.ts";
import { sseResponse } from "./sse.ts";

const dottedTools = [{
  type: "function" as const,
  function: {
    name: "context.query",
    description: "查询历史",
    parameters: { type: "object", properties: { sumId: { type: "string" } }, required: ["sumId"] },
  },
}];

const toolCallEvent = (name: string, args: string) => ({
  choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: args } }] } }],
});

test("sanitizeToolNames sends underscore names and restores dots on return", async () => {
  let sent: any;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      sent = await request.json();
      return sseResponse([
        toolCallEvent("context_query", JSON.stringify({ sumId: "sum_01", module: "toolIO", intent: "查" })),
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ]);
    },
  });
  try {
    const provider = createProvider({
      apiKey: "local-test",
      baseURL: `http://127.0.0.1:${server.port}/v1`,
      proxy: "",
      sanitizeToolNames: true,
    });
    const result = await provider.complete({ messages: [{ role: "user", content: "查" }], tools: dottedTools });
    expect(sent.tools[0].function.name).toBe("context_query");
    expect(sent.tool_choice).toBeUndefined();
    expect(result.toolCalls[0]?.name).toBe("context.query");
    expect(result.parseOk).toBe(true);
  } finally { server.stop(true); }
});

test("without sanitizeToolNames original dotted names are sent", async () => {
  let sent: any;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      sent = await request.json();
      return sseResponse([
        { choices: [{ index: 0, delta: { content: "ok" } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]);
    },
  });
  try {
    const provider = createProvider({ apiKey: "local-test", baseURL: `http://127.0.0.1:${server.port}/v1`, proxy: "" });
    await provider.complete({ messages: [{ role: "user", content: "hi" }], tools: dottedTools });
    expect(sent.tools[0].function.name).toBe("context.query");
    expect(sent.tool_choice).toBeUndefined();
  } finally { server.stop(true); }
});
