import OpenAI from "openai";
import { completeResponses } from "./responses.ts";
import { readImageDataUrl } from "../images/store.ts";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { parseToolArguments } from "../tools/arguments.ts";
import type { ChatMessage, ChatTool, CompletionResult, ToolCall, ToolCallFault } from "../types.ts";

const MODEL = "gemini-3.8-flash";
const MAX_ATTEMPTS = 3;

export type ProviderConfig = {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  proxy?: string;
  api?: "chat" | "responses";
};

export function resolveProxy(env: Record<string, string | undefined>) {
  if (env.TCHROME_PROXY_MODE === "direct") return "";
  const address = env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY;
  if (env.TCHROME_PROXY_MODE === "proxy") return address || "http://127.0.0.1:7892";
  return address;
}

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

const parseCalls = (calls: AccCall[]) => {
  const toolCalls: ToolCall[] = [];
  const faults: ToolCallFault[] = [];
  for (const call of calls) {
    if (!call.id && !call.name) continue;
    const parsed = parseToolArguments(call.arguments);
    if (!parsed.ok) {
      faults.push({ callId: call.id, name: call.name, rawArguments: call.arguments, detail: parsed.detail });
      continue;
    }
    toolCalls.push({
      id: call.id,
      name: call.name,
      arguments: parsed.value,
    });
  }
  return { toolCalls, faults, parseOk: faults.length === 0 };
};

export function createProvider(config: ProviderConfig = {}) {
  const apiKey = config.apiKey ?? Bun.env.UUAPI_API_KEY;
  const baseURL = config.baseURL ?? "https://uuapi.net/v1";
  const model = config.model ?? MODEL;
  const reasoningEffort = config.reasoningEffort ?? Bun.env.UUAPI_REASONING_EFFORT ?? "high";
  if (reasoningEffort !== "low" && reasoningEffort !== "medium" && reasoningEffort !== "high") {
    throw new Error("UUAPI_REASONING_EFFORT must be low, medium or high");
  }
  const proxy = config.proxy ?? resolveProxy(Bun.env);
  if (!apiKey) return { complete: async () => keyMissing() };
  const client = new OpenAI({
    apiKey,
    baseURL,
    maxRetries: 0,
    ...(proxy
      ? {
          fetch: (url: RequestInfo | URL, init?: RequestInit) =>
            fetch(url, { ...init, proxy } as RequestInit),
        }
      : {}),
  });

  const once = async (messages: ChatMessage[], tools: ChatTool[], imageContext?: { dataDir: string; conversationId: string }) => {
    if (config.api === "responses") return completeResponses(client, { model, reasoningEffort, messages, tools, imageContext });
    const outgoing: ChatCompletionMessageParam[] = messages.map(message => {
      if (!message.images?.length) return { role: message.role, content: message.content };
      if (message.role !== "user" || !imageContext) throw new Error("图片请求缺少有效会话上下文");
      return { role: "user", content: [
        { type: "text", text: message.content },
        ...message.images.flatMap(image => [
          { type: "text" as const, text: `附图：${image.path}（${image.width}×${image.height}）` },
          { type: "image_url" as const, image_url: { url: readImageDataUrl(imageContext.dataDir, imageContext.conversationId, image) } },
        ]),
      ] };
    });
    const response = await client.chat.completions.create({
      model,
      reasoning_effort: reasoningEffort,
      stream: false,
      messages: outgoing,
      tools,
    });
    const choice = response.choices[0];
    if (!choice) throw new Error("empty_choices");
    const calls: AccCall[] = (choice.message.tool_calls ?? []).map((call) => {
      if (call.type !== "function") throw new Error("unsupported_tool_call");
      return { id: call.id, name: call.function.name, arguments: call.function.arguments };
    });
    return { content: choice.message.content ?? "", calls, finish: choice.finish_reason };
  };

  return {
    complete: async (input: {
      messages: ChatMessage[];
      tools: ChatTool[];
      imageContext?: { dataDir: string; conversationId: string };
    }): Promise<CompletionResult> => {
      let lastError: unknown;
      let attempts = 0;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        attempts = attempt;
        try {
          const { content, calls, finish } = await once(input.messages, input.tools, input.imageContext);
          // Only a completed tool-call batch may reach argument parsing and execution.
          if (finish !== "tool_calls") {
            const stopped = finish === "stop" && calls.length === 0;
            return {
              finish: stopped ? "stop" : "error",
              content,
              toolCalls: [],
              attempts: attempt,
              parseOk: stopped,
              schemaOk: stopped,
              faultCode: stopped ? null : "provider_error",
              missing: [],
              ...(stopped ? {} : { detail: `Unexpected provider finish reason: ${finish}` }),
            };
          }
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
              toolCallFaults: parsed.faults,
              badName: parsed.faults[0]?.name,
              detail: parsed.faults.map((fault) => `${fault.name}: ${fault.detail}`).join("; "),
            };
          }
          if (parsed.toolCalls.length === 0) {
            return {
              finish: "error",
              content,
              toolCalls: parsed.toolCalls,
              attempts: attempt,
              parseOk: true,
              schemaOk: true,
              faultCode: "provider_error",
              missing: [],
            };
          }
          return {
            finish: "tool_calls",
            content,
            toolCalls: parsed.toolCalls,
            attempts: attempt,
            parseOk: true,
            schemaOk: true,
            faultCode: null,
            missing: [],
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
        attempts,
        parseOk: false,
        schemaOk: false,
        faultCode: status === 401 || status === 403 ? "provider_key_invalid" : "provider_error",
        detail: `status=${status}; ${lastError instanceof Error ? lastError.message : "unknown provider error"}`.replaceAll(apiKey, "[REDACTED]"),
        missing: [],
      };
    },
  };
}
