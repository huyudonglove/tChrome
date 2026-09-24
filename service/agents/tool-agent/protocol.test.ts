import { expect, test } from "bun:test";
import type { ChatTool, CompletionResult, Provider } from "../../types.ts";
import { requestToolResult } from "./protocol.ts";

const decisionTool: ChatTool = {
  type: "function",
  function: {
    name: "submitDecision",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        action: { type: "string", enum: ["retry", "stop"] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["id", "action", "confidence"],
      additionalProperties: false,
    },
  },
};

function response(argumentsValue: Record<string, unknown>, name = "submitDecision"): CompletionResult {
  return {
    finish: "tool_calls",
    content: "",
    toolCalls: [{ id: "call_1", name, arguments: argumentsValue }],
    attempts: 1,
    parseOk: true,
    schemaOk: true,
    faultCode: null,
    missing: [],
  };
}

function run(responses: CompletionResult[], validateResult?: (value: Record<string, unknown>) => string | null) {
  let index = 0;
  return requestToolResult({
    provider: {
      async complete() {
        return responses[index++]!;
      },
    },
    protocol: {
      agentName: "Decision Agent",
      faultCode: "decision_failed",
      systemPrompt: "decide",
      userPrompt: "payload",
      tool: decisionTool,
      toolName: "submitDecision",
      repairInstruction: fault => `fix:${fault}`,
      validateResult,
    },
  });
}

test("tool Agent returns any schema-valid structured object", async () => {
  const result = await run([response({ id: "task_1", action: "retry", confidence: 0.8 })]);
  expect(result).toEqual({ id: "task_1", action: "retry", confidence: 0.8 });
});

test("tool Agent repairs schema-invalid structured output", async () => {
  const result = await run([
    response({ id: "task_1", action: "retry" }),
    response({ id: "task_1", action: "stop", confidence: 0.7 }),
  ]);
  expect(result.action).toBe("stop");
});

test("tool Agent repairs domain-invalid output through injected validation", async () => {
  const result = await run([
    response({ id: "x", action: "retry", confidence: 0.8 }),
    response({ id: "ok", action: "stop", confidence: 0.7 }),
  ], value => value.id === "ok" ? null : "id is not allowed");
  expect(result).toEqual({ id: "ok", action: "stop", confidence: 0.7 });
});

test("tool Agent rejects malformed or semantically invalid output after three attempts", async () => {
  await expect(run([
    response({ id: "x", action: "retry", confidence: 0.8 }),
    response({ id: "x", action: "retry", confidence: 0.8 }),
    response({ id: "x", action: "retry", confidence: 0.8 }),
  ], () => "id is not allowed")).rejects.toThrow("id is not allowed");

  await expect(run([
    response({ id: "task_1", action: "retry" }),
    response({ id: "task_1", action: "retry" }),
    response({ id: "task_1", action: "retry" }),
  ])).rejects.toThrow("不符合 schema");
});
