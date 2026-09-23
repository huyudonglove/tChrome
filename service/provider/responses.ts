import type OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import { readImageDataUrl } from "../images/store.ts";
import { sseDataEvents } from "./sse.ts";
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
    stream: true,
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
  if (!rawResponse.ok || !rawResponse.body) {
    const payload = await rawResponse.json().catch(() => ({})) as { error?: { message?: string; code?: string } };
    const code = String(payload.error?.code ?? rawResponse.status);
    const message = payload.error?.message || `HTTP ${rawResponse.status}`;
    const kind = code === "server_error" || rawResponse.status >= 500 ? "server_error" : code === "rate_limit_exceeded" || rawResponse.status === 429 ? "rate_limit"
      : code === "content_filter" ? "refused" : rawResponse.status === 401 || rawResponse.status === 403 ? "provider_key_invalid" : "invalid_response";
    throw new ProviderFailure(kind as "server_error", `responses_error: ${code}; ${message}`);
  }

  let content = "";
  const calls: { id: string; name: string; arguments: string }[] = [];
  let status = "";
  let incompleteReason = "";
  let refusal = false;
  let errorMessage = "";

  for await (const data of sseDataEvents(rawResponse.body)) {
    const event = JSON.parse(data) as {
      type?: string;
      delta?: string;
      item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string; status?: string };
      response?: {
        status?: string;
        error?: { code?: string; message?: string };
        incomplete_details?: { reason?: string };
        output?: { type?: string; status?: string; call_id?: string; name?: string; arguments?: string; content?: { type?: string; text?: string; refusal?: string }[] }[];
      };
    };
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      content += event.delta;
    } else if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      if (event.item.status && event.item.status !== "completed") {
        throw new ProviderFailure("incomplete", `responses_call_${event.item.status}`);
      }
      if (typeof event.item.call_id !== "string" || !event.item.call_id.trim()
        || typeof event.item.name !== "string" || !event.item.name.trim()
        || typeof event.item.arguments !== "string") {
        throw new ProviderFailure("invalid_response", "responses_invalid_function_call");
      }
      calls.push({ id: event.item.call_id, name: event.item.name, arguments: event.item.arguments });
    } else if (event.type === "response.refusal.delta" || event.type === "response.refusal.done") {
      refusal = true;
    } else if (event.type === "response.failed" || event.type === "response.incomplete") {
      status = event.type === "response.failed" ? "failed" : "incomplete";
      incompleteReason = event.response?.incomplete_details?.reason ?? "";
      errorMessage = event.response?.error?.message ?? "";
      const code = event.response?.error?.code ?? "";
      if (code === "content_filter") refusal = true;
    } else if (event.type === "response.completed") {
      status = event.response?.status ?? "completed";
      // Prefer the authoritative completed payload for messages/calls if present.
      if (Array.isArray(event.response?.output)) {
        calls.length = 0;
        const texts: string[] = [];
        for (const item of event.response.output) {
          if (item?.type === "function_call") {
            if (item.status && item.status !== "completed") throw new ProviderFailure("incomplete", `responses_call_${item.status}`);
            if (typeof item.call_id !== "string" || !item.call_id.trim() || typeof item.name !== "string" || !item.name.trim() || typeof item.arguments !== "string") {
              throw new ProviderFailure("invalid_response", "responses_invalid_function_call");
            }
            calls.push({ id: item.call_id, name: item.name, arguments: item.arguments });
          } else if (item?.type === "message") {
            if (item.status && item.status !== "completed") throw new ProviderFailure("incomplete", `responses_message_${item.status}`);
            if (!Array.isArray(item.content)) throw new ProviderFailure("invalid_response", "responses_invalid_content");
            for (const part of item.content) {
              if (!part) throw new ProviderFailure("invalid_response", "responses_invalid_content_part");
              if (part.type === "refusal") throw new ProviderFailure("refused", "responses_content_refused");
              if (part.type === "output_text") {
                if (typeof part.text !== "string") throw new ProviderFailure("invalid_response", "responses_invalid_text");
                texts.push(part.text);
              }
            }
          }
        }
        if (texts.length) content = texts.join("\n");
      }
    }
  }

  if (refusal) throw new ProviderFailure("refused", "responses_content_refused");
  if (status === "failed" || status === "incomplete") {
    const kind = incompleteReason === "max_output_tokens" ? "output_limit" : incompleteReason === "content_filter" ? "refused"
      : status === "incomplete" ? "incomplete" : "invalid_response";
    throw new ProviderFailure(kind, `responses_${status}: ${incompleteReason || errorMessage || "response not completed"}`);
  }
  if (!status && !calls.length && !content) throw new ProviderFailure("invalid_response", "responses_empty_output");
  if (!calls.length && !content.trim()) throw new ProviderFailure("invalid_response", "responses_empty_output");
  return { content, calls, finish: calls.length ? "tool_calls" : "stop" };
}
