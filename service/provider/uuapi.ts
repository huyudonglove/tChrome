import OpenAI from "openai";
import { setTimeout as sleep } from "node:timers/promises";
import { completeResponses } from "./responses.ts";
import { ProviderFailure, classifyProviderFailure } from "./failures.ts";
import { runtimeConfig } from "../config/runtime.ts";
import { fetchWithIdleTimeout } from "../network/idle-fetch.ts";
import { readImageDataUrl } from "../images/store.ts";
import type { ChatCompletion, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { parseToolArguments } from "../tools/arguments.ts";
import type { ChatMessage, ChatTool, CompletionResult, ToolCall, ToolCallFault } from "../types.ts";

const MODEL = "gemini-3.8-flash";

export type ProviderConfig = {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  proxy?: string;
  api?: "chat" | "responses";
  /** Gateways that reject dots in function names (e.g. New API). Runtime names stay unchanged. */
  sanitizeToolNames?: boolean;
};

export function resolveProxy(env: Record<string, string | undefined>) {
  if (env.TCHROME_PROXY_MODE === "direct") return "";
  const address = env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY;
  if (env.TCHROME_PROXY_MODE === "proxy") return address || "http://127.0.0.1:7892";
  return address;
}

const stoppedResult = (attempts: number): CompletionResult => ({
  finish: "error",
  content: "",
  toolCalls: [],
  attempts,
  parseOk: false,
  schemaOk: false,
  faultCode: "stopped",
  missing: [],
});

type CompletionInput = {
  messages: ChatMessage[];
  tools: ChatTool[];
  imageContext?: { dataDir: string; conversationId: string };
  signal?: AbortSignal;
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

/** OpenAI-compatible names allow only [A-Za-z0-9_-]; map dots for strict gateways and restore on return. */
const wireName = (name: string) => name.replaceAll(".", "_");

function mapToolsForWire(tools: ChatTool[], sanitize: boolean) {
  if (!sanitize) return { tools, byWire: new Map<string, string>() };
  const byWire = new Map<string, string>();
  const mapped = tools.map((tool) => {
    const name = wireName(tool.function.name);
    byWire.set(name, tool.function.name);
    return { ...tool, function: { ...tool.function, name } };
  });
  return { tools: mapped, byWire };
}

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
  if (!apiKey) return { complete: async (input: CompletionInput) => input.signal?.aborted ? stoppedResult(0) : keyMissing() };
  const client = new OpenAI({
    apiKey,
    baseURL,
    maxRetries: 0,
    // Match the initial-response deadline; bodies use the shared idle transport below.
    timeout: runtimeConfig.network.idleTimeoutMs,
    fetch: (url: RequestInfo | URL, init?: RequestInit) =>
      fetchWithIdleTimeout(url, { ...init, ...(proxy ? { proxy } : {}) } as RequestInit),
  });

  const once = async (messages: ChatMessage[], tools: ChatTool[], imageContext?: { dataDir: string; conversationId: string }, signal?: AbortSignal) => {
    if (config.api === "responses") return completeResponses(client, { model, reasoningEffort, messages, tools, imageContext, signal });
    const sanitize = config.sanitizeToolNames === true;
    const { tools: wireTools, byWire } = mapToolsForWire(tools, sanitize);
    const outgoing: ChatCompletionMessageParam[] = messages.map(message => {
      if (!message.images?.length) return { role: message.role, content: message.content };
      if (message.role !== "user" || !imageContext) throw new Error("图片请求缺少有效会话上下文");
      return { role: "user", content: [
        { type: "text", text: message.content },
        ...message.images.flatMap(image => [
          { type: "text" as const, text: `附图：${image.id}${image.callId ? `，callId=${image.callId}` : ""}，${image.path}（${image.width}×${image.height}）` },
          { type: "image_url" as const, image_url: { url: readImageDataUrl(imageContext.dataDir, imageContext.conversationId, image) } },
        ]),
      ] };
    });
    const rawResponse = await client.chat.completions.create({
      model,
      reasoning_effort: reasoningEffort,
      stream: false,
      messages: outgoing,
      tools: wireTools,
      ...(wireTools.length ? { tool_choice: "required" as const } : {}),
    }, { signal }).asResponse();
    // Avoid the SDK's total body-duration timeout: received chunks reset our idle timer.
    const response = await rawResponse.json() as ChatCompletion;
    const choice = response?.choices?.[0];
    if (!choice?.message) throw new ProviderFailure("invalid_response", "chat_missing_choice_or_message");
    if (choice.finish_reason === "content_filter" || choice.message.refusal) throw new ProviderFailure("refused", "chat_content_refused");
    if (choice.finish_reason === "length") throw new ProviderFailure("output_limit", "chat_output_limit");
    if (!["stop", "tool_calls"].includes(choice.finish_reason)) throw new ProviderFailure("invalid_response", `chat_unexpected_finish: ${choice.finish_reason}`);
    if (choice.message.tool_calls != null && !Array.isArray(choice.message.tool_calls)) throw new ProviderFailure("invalid_response", "chat_invalid_tool_calls");
    const calls: AccCall[] = (choice.message.tool_calls ?? []).map((call) => {
      if (call?.type !== "function" || typeof call.id !== "string" || !call.id.trim()
        || typeof call.function?.name !== "string" || !call.function.name.trim() || typeof call.function.arguments !== "string") {
        throw new ProviderFailure("invalid_response", "chat_invalid_function_call");
      }
      return { id: call.id, name: byWire.get(call.function.name) ?? call.function.name, arguments: call.function.arguments };
    });
    if (choice.message.content != null && typeof choice.message.content !== "string") throw new ProviderFailure("invalid_response", "chat_invalid_content");
    if (choice.finish_reason === "stop" && calls.length) throw new ProviderFailure("invalid_response", "chat_stop_with_tool_calls");
    if (choice.finish_reason === "tool_calls" && !calls.length) throw new ProviderFailure("invalid_response", "chat_missing_tool_calls");
    if (!calls.length && !choice.message.content?.trim()) throw new ProviderFailure("invalid_response", "chat_empty_output");
    return { content: choice.message.content ?? "", calls, finish: choice.finish_reason };
  };

  return {
    complete: async (input: CompletionInput): Promise<CompletionResult> => {
      let lastError: unknown;
      let attempts = 0;
      for (let attempt = 1; attempt <= runtimeConfig.network.maxAttempts; attempt++) {
        if (input.signal?.aborted) return stoppedResult(attempts);
        attempts = attempt;
        try {
          const { content, calls, finish } = await once(input.messages, input.tools, input.imageContext, input.signal);
          if (input.signal?.aborted) return stoppedResult(attempts);
          // Both adapters reject incomplete or invalid batches before argument parsing.
          if (finish === "stop") {
            return {
              finish: "stop",
              content,
              toolCalls: [],
              attempts: attempt,
              parseOk: true,
              schemaOk: true,
              faultCode: null,
              missing: [],
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
          if (input.signal?.aborted) return stoppedResult(attempts);
          lastError = error;
          if (!classifyProviderFailure(error).retryable || attempt === runtimeConfig.network.maxAttempts) break;
          try {
            await sleep(runtimeConfig.network.retryDelayMs, undefined, { signal: input.signal });
          } catch (waitError) {
            if (input.signal?.aborted) return stoppedResult(attempts);
            throw waitError;
          }
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
        faultCode: classifyProviderFailure(lastError).faultCode,
        detail: `status=${status}; ${lastError instanceof Error ? lastError.message : "unknown provider error"}`.replaceAll(apiKey, "[REDACTED]"),
        missing: [],
      };
    },
  };
}
