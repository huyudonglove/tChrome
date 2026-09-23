import { expect, test } from "bun:test";
import { createProvider } from "./uuapi.ts";
import { sseResponse } from "./sse.ts";

const responsesDone = (output: unknown[]) => sseResponse([
  ...output.flatMap((item) => {
    const row = item as { type?: string; content?: { type?: string; text?: string }[] };
    if (row.type === "message") {
      return (row.content ?? []).map((part) => ({
        type: "response.output_text.delta",
        delta: part.type === "output_text" ? part.text : "",
      }));
    }
    return [{
      type: "response.output_item.done",
      item: { ...(item as object), status: "completed" },
    }];
  }),
  { type: "response.completed", response: { status: "completed", output } },
]);

test("Responses sends flat tools and high reasoning and normalizes message plus function calls", async () => {
  let body: any;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(new URL(request.url).pathname).toBe("/v1/responses");
    body = await request.json();
    return responsesDone([
      { type: "message", content: [{ type: "output_text", text: "执行下一步" }] },
      { type: "function_call", id: "item_1", call_id: "call_1", name: "finishTurn", arguments: '{"text":"完成"}' },
    ]);
  } });
  try {
    const result = await createProvider({ api: "responses", apiKey: "test", baseURL: `http://127.0.0.1:${server.port}/v1`, model: "grok-4.6", proxy: "" }).complete({
      messages: [{ role: "system", content: "规则" }, { role: "user", content: "请求" }],
      tools: [{ type: "function", function: { name: "finishTurn", parameters: { type: "object", properties: { text: { type: "string" } } } } }],
    });
    expect(body).toMatchObject({ model: "grok-4.6", store: false, stream: true, reasoning: { effort: "high" } });
    expect(body.tools[0]).toMatchObject({ type: "function", name: "finishTurn", strict: false });
    expect(body.tool_choice).toBeUndefined();
    expect(body.previous_response_id).toBeUndefined();
    expect(result).toMatchObject({ finish: "tool_calls", content: "执行下一步", toolCalls: [{ id: "call_1", name: "finishTurn", arguments: { text: "完成"} }] });
  } finally { server.stop(true); }
});

test("toolChoice required 发送 tool_choice，被拒后降级 auto", async () => {
  let requests = 0;
  const bodies: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests++;
    const body = await request.json();
    bodies.push(body);
    if (body.tool_choice === "required") {
      return Response.json({ error: { code: "invalid_request_error", message: "tool_choice required is not supported" } }, { status: 400 });
    }
    return responsesDone([
      { type: "function_call", id: "item_1", call_id: "call_1", name: "finishTurn", arguments: '{"text":"完成"}' },
    ]);
  } });
  try {
    const result = await createProvider({ api: "responses", apiKey: "test", baseURL: `http://127.0.0.1:${server.port}/v1`, model: "grok-4.6", proxy: "" }).complete({
      messages: [{ role: "user", content: "请求" }],
      tools: [{ type: "function", function: { name: "finishTurn", parameters: { type: "object", properties: { text: { type: "string" } } } } }],
      toolChoice: "required",
    });
    expect(requests).toBe(2);
    expect(bodies[0]!.tool_choice).toBe("required");
    expect(bodies[1]!.tool_choice).toBeUndefined();
    expect(result.attempts).toBe(1);
    expect(result.toolCalls[0]?.name).toBe("finishTurn");
  } finally { server.stop(true); }
});
