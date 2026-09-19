import { expect, test } from "bun:test";
import { createProvider } from "./uuapi.ts";

const dottedTools = [{
  type: "function" as const,
  function: {
    name: "context.query",
    description: "查询历史",
    parameters: { type: "object", properties: { sumId: { type: "string" } }, required: ["sumId"] },
  },
}];

test("sanitizeToolNames sends underscore names and restores dots on return", async () => {
  let sent: any;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      sent = await request.json();
      return Response.json({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "context_query", arguments: JSON.stringify({ sumId: "sum_01", module: "toolIO", intent: "查" }) },
            }],
          },
        }],
      });
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
    expect(sent.tool_choice).toBe("required");
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
      return Response.json({
        choices: [{
          finish_reason: "stop",
          message: { role: "assistant", content: "ok" },
        }],
      });
    },
  });
  try {
    const provider = createProvider({ apiKey: "local-test", baseURL: `http://127.0.0.1:${server.port}/v1`, proxy: "" });
    await provider.complete({ messages: [{ role: "user", content: "hi" }], tools: dottedTools });
    expect(sent.tools[0].function.name).toBe("context.query");
    expect(sent.tool_choice).toBe("required");
  } finally { server.stop(true); }
});
