import type OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import { readImageDataUrl } from "../images/store.ts";
import type { ChatMessage, ChatTool } from "../types.ts";

export async function completeResponses(client: OpenAI, input: {
  model: string;
  reasoningEffort: "low" | "medium" | "high";
  messages: ChatMessage[];
  tools: ChatTool[];
  imageContext?: { dataDir: string; conversationId: string };
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
          { type: "input_text" as const, text: `附图：${image.path}（${image.width}×${image.height}）` },
          {
            type: "input_image" as const,
            image_url: readImageDataUrl(context.dataDir, context.conversationId, image),
            detail: "auto" as const,
          },
        ]),
      ],
    };
  });
  const response = await client.responses.create({
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
  });

  // Never execute partial calls, including ones preceding an incomplete message.
  if (response.status !== "completed" || response.error) {
    throw new Error(`responses_${response.status ?? "missing_status"}: ${response.error?.message ?? response.incomplete_details?.reason ?? "response not completed"}`);
  }
  const calls: { id: string; name: string; arguments: string }[] = [];
  const text: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type === "function_call") {
      if (item.status && item.status !== "completed") throw new Error(`responses_call_${item.status}`);
      if (!item.call_id || !item.name || typeof item.arguments !== "string") {
        throw new Error("responses_invalid_function_call");
      }
      calls.push({ id: item.call_id, name: item.name, arguments: item.arguments });
    } else if (item.type === "message") {
      if (item.status && item.status !== "completed") throw new Error(`responses_message_${item.status}`);
      for (const part of item.content) {
        if (part.type === "refusal") throw new Error(`responses_refusal: ${part.refusal}`);
        if (part.type === "output_text") text.push(part.text);
      }
    }
  }
  const content = text.join("\n");
  if (!calls.length && !content.trim()) throw new Error("responses_empty_output");
  return { content, calls, finish: calls.length ? "tool_calls" : "stop" };
}
