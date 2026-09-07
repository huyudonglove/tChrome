import OpenAI from "openai";
import type { ChatCompletionChunk, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { checkToolCalls } from "../tools/schema.ts";
import type { ChatMessage, ChatTool, CompletionResult, ToolCall } from "../types.ts";

const MODEL = "gemini-3.7-flash";
const MAX_ATTEMPTS = 3;

export type ProviderConfig = {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  proxy?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const retryable = (error: unknown) => {
  if (error && typeof error === "object" && "status" in error) {
    const status = Number((error as { status: number }).status);
    if (status === 429 || status >= 500) return true;
    if (status >= 400) return false;
  }
  return true;
};

const keyMissing = () => {
  const result: CompletionResult = {
    finish: "error",
    content: "",
    toolCalls: [],
    attempts: 0,
    parseOk: false,
    schemaOk: false,
    faultCode: "provider_key_missing",
    missing: [],
  };
  return result;
};

type AccCall = { id: string; name: string; arguments: string };

const mergeChunk = (
  content: string,
  calls: AccCall[],
  chunk: ChatCompletionChunk,
): { content: string; finish: string | null } => {
  const choice = chunk.choices[0];
  const delta = choice?.delta;
  if (delta?.content) content += delta.content;
  for (const part of delta?.tool_calls ?? []) {
    const index = part.index ?? 0;
    const current = calls[index] ?? { id: "", name: "", arguments: "" };
    if (part.id) current.id = part.id;
    if (part.function?.name) current.name = part.function.name;
    if (part.function?.arguments) current.arguments += part.function.arguments;
    calls[index] = current;
  }
  return { content, finish: choice?.finish_reason ?? null };
};

const parseCalls = (calls: AccCall[]): { toolCalls: ToolCall[]; parseOk: boolean; detail: string; badName: string } => {
  const toolCalls: ToolCall[] = [];
  for (const call of calls) {
    if (!call.id && !call.name) continue;
    try {
      toolCalls.push({
        id: call.id,
        name: call.name,
        arguments: JSON.parse(call.arguments || "{}"),
      });
    } catch (error) {
      return {
        toolCalls,
        parseOk: false,
        detail: error instanceof Error ? error.message : String(error),
        badName: call.name || "unknown",
      };
    }
  }
  return { toolCalls, parseOk: true, detail: "", badName: "" };
};

export function createProvider(config: ProviderConfig = {}) {
  const apiKey = config.apiKey ?? Bun.env.UUAPI_API_KEY;
  const baseURL = config.baseURL ?? "https://uuapi.net/v1";
  const model = config.model ?? MODEL;
  const proxy = config.proxy ?? Bun.env.HTTPS_PROXY ?? Bun.env.HTTP_PROXY ?? Bun.env.ALL_PROXY;
  if (!apiKey) return { complete: async () => keyMissing() };
  const client = new OpenAI({
    apiKey,
    baseURL,
    ...(proxy
      ? {
          fetch: (url: RequestInfo | URL, init?: RequestInit) =>
            fetch(url, { ...init, proxy } as RequestInit),
        }
      : {}),
  });

  const once = async (messages: ChatMessage[], tools: ChatTool[]) => {
    const stream = await client.chat.completions.create({
      model,
      stream: true,
      messages: messages as ChatCompletionMessageParam[],
      tools,
    });
    let content = "";
    const calls: AccCall[] = [];
    let finish: string | null = null;
    for await (const chunk of stream) {
      const next = mergeChunk(content, calls, chunk);
      content = next.content;
      if (next.finish) finish = next.finish;
    }
    if (!finish) throw new Error("stream_incomplete");
    return { content, calls, finish };
  };

  return {
    complete: async (input: {
      messages: ChatMessage[];
      tools: ChatTool[];
      baseToolsIds: string[];
      toolIds: string[];
    }): Promise<CompletionResult> => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const { content, calls, finish } = await once(input.messages, input.tools);
          const parsed = parseCalls(calls);
          if (!parsed.parseOk) {
            return {
              finish: "tool_calls",
              content,
              toolCalls: parsed.toolCalls,
              attempts: attempt,
              parseOk: false,
              schemaOk: false,
              faultCode: "arguments_not_json",
              missing: [],
              detail: `${parsed.badName}: ${parsed.detail}`,
            };
          }
          if (finish !== "tool_calls" || parsed.toolCalls.length === 0) {
            return {
              finish: finish === "stop" ? "stop" : "error",
              content,
              toolCalls: parsed.toolCalls,
              attempts: attempt,
              parseOk: true,
              schemaOk: true,
              faultCode: finish === "stop" ? null : "provider_error",
              missing: [],
            };
          }
          const check = checkToolCalls(parsed.toolCalls, input.tools, input.baseToolsIds, input.toolIds);
          return {
            finish: "tool_calls",
            content,
            toolCalls: parsed.toolCalls,
            attempts: attempt,
            ...check,
          };
        } catch (error) {
          lastError = error;
          if (!retryable(error) || attempt === MAX_ATTEMPTS) break;
          await sleep(1000);
        }
      }
      const status = lastError && typeof lastError === "object" && "status" in lastError
        ? Number((lastError as { status: number }).status)
        : 0;
      return {
        finish: "error",
        content: "",
        toolCalls: [],
        attempts: MAX_ATTEMPTS,
        parseOk: false,
        schemaOk: false,
        faultCode: status === 401 || status === 403 ? "provider_key_invalid" : "provider_error",
        missing: [],
      };
    },
  };
}
