import type OpenAI from "openai";
import type { ResponseInput, Response as ModelResponse } from "openai/resources/responses/responses";
import { readImageDataUrl } from "../images/store.ts";
import type { ChatMessage, ChatTool } from "../types.ts";
import { ProviderFailure } from "./failures.ts";

export async function completeResponses(client: OpenAI, input: {
  model: string;
  reasoningEffort: "low" | "medium" | "high";
  messages: ChatMessage[];
  tools: ChatTool[];
  imageContext?: { dataDir: string; conversationId: string };
  signal?: AbortSignal;
  toolChoice?: "auto" | "required";
}): Promise<{
  content: string;
  calls: { id: string; name: string; arguments: string }[];
  finish: "tool_calls" | "stop";
}> {
  const outgoing: ResponseInput = input.messages.map(message => {
    if (!message.images?.length) return { role: message.role, content: message.content };
    const context = input.imageContext;
    if (message.role !== "user" || !context) throw new Error("图片请求缺少有效会话上下文");
    return {
      role: "user",
      content: [
        { type: "input_text", text: message.content },
        ...message.images.flatMap(image => [
          { type: "input_text" as const, text: `附图：${image.id}${image.callId ? `，callId=${image.callId}` : ""}，${image.path}（${image.width}×${image.height}）` },
          {
            type: "input_image" as const,
            image_url: readImageDataUrl(context.dataDir, context.conversationId, image),
            detail: "auto" as const,
          },
        ]),
      ],
    };
  });
  const rawResponse = await client.responses.create({
    model: input.model,
    reasoning: { effort: input.reasoningEffort },
    stream: false,
    store: false,
    input: outgoing,
    tools: input.tools.map(tool => ({
      type: "function",
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
      strict: false,
    })),
    ...(input.toolChoice === "required" ? { tool_choice: "required" as const } : {}),
  }, { signal: input.signal }).asResponse();
  const response = await rawResponse.json() as ModelResponse;

  // Never execute partial calls, including ones preceding an incomplete message.
  if (response?.error) {
    const code = String(response.error.code);
    const kind = code === "server_error" ? "server_error" : code === "rate_limit_exceeded" ? "rate_limit"
      : code === "content_filter" ? "refused" : "invalid_response";
    throw new ProviderFailure(kind, `responses_error: ${code}; ${response.error.message}`);
  }
  if (response?.status !== "completed") {
    const reason = response?.incomplete_details?.reason;
    const kind = reason === "max_output_tokens" ? "output_limit" : reason === "content_filter" ? "refused"
      : ["incomplete", "in_progress", "queued", "cancelled"].includes(response?.status ?? "") ? "incomplete" : "invalid_response";
    throw new ProviderFailure(kind, `responses_${response?.status ?? "missing_status"}: ${reason ?? "response not completed"}`);
  }
  if (!Array.isArray(response.output)) throw new ProviderFailure("invalid_response", "responses_missing_output");
  const calls: { id: string; name: string; arguments: string }[] = [];
  const text: string[] = [];
  for (const item of response.output) {
    if (!item || typeof item !== "object") throw new ProviderFailure("invalid_response", "responses_invalid_output_item");
    if (item.type === "function_call") {
      if (item.status && item.status !== "completed") throw new ProviderFailure("incomplete", `responses_call_${item.status}`);
      if (typeof item.call_id !== "string" || !item.call_id.trim() || typeof item.name !== "string" || !item.name.trim() || typeof item.arguments !== "string") {
        throw new ProviderFailure("invalid_response", "responses_invalid_function_call");
      }
      calls.push({ id: item.call_id, name: item.name, arguments: item.arguments });
    } else if (item.type === "message") {
      if (item.status && item.status !== "completed") throw new ProviderFailure("incomplete", `responses_message_${item.status}`);
      if (!Array.isArray(item.content)) throw new ProviderFailure("invalid_response", "responses_invalid_content");
      for (const part of item.content) {
        if (!part) throw new ProviderFailure("invalid_response", "responses_invalid_content_part");
        if (part.type === "refusal") throw new ProviderFailure("refused", "responses_content_refused");
        if (part.type === "output_text") {
          if (typeof part.text !== "string") throw new ProviderFailure("invalid_response", "responses_invalid_text");
          text.push(part.text);
        }
      }
    }
  }
  const content = text.join("\n");
  if (!calls.length && !content.trim()) throw new ProviderFailure("invalid_response", "responses_empty_output");
  return { content, calls, finish: calls.length ? "tool_calls" : "stop" };
}
