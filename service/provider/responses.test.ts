import { expect, test } from "bun:test";
import { createProvider } from "./uuapi.ts";

test("Responses sends flat tools and high reasoning and normalizes message plus function calls", async () => {
  let body: any;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(new URL(request.url).pathname).toBe("/v1/responses");
    body = await request.json();
    return Response.json({ status: "completed", output: [
      { type: "message", content: [{ type: "output_text", text: "执行下一步" }] },
      { type: "function_call", id: "item_1", call_id: "call_1", name: "finishTurn", arguments: '{"text":"完成"}' },
    ] });
  } });
  try {
    const result = await createProvider({ api: "responses", apiKey: "test", baseURL: `http://127.0.0.1:${server.port}/v1`, model: "grok-4.6", proxy: "" }).complete({
      messages: [{ role: "system", content: "规则" }, { role: "user", content: "请求" }],
      tools: [{ type: "function", function: { name: "finishTurn", parameters: { type: "object", properties: { text: { type: "string" } } } } }],
    });
    expect(body).toMatchObject({ model: "grok-4.6", store: false, stream: false, reasoning: { effort: "high" } });
    expect(body.tools[0]).toMatchObject({ type: "function", name: "finishTurn", strict: false });
    expect(body.tool_choice).toBe("required");
    expect(body.previous_response_id).toBeUndefined();
    expect(result).toMatchObject({ finish: "tool_calls", content: "执行下一步", toolCalls: [{ id: "call_1", name: "finishTurn", arguments: { text: "完成"} }] });
  } finally { server.stop(true); }
});
