import OpenAI from "openai";
import { setTimeout as sleep } from "node:timers/promises";
import { completeResponses } from "./responses.ts";
import { sseDataEvents } from "./sse.ts";
import { ProviderFailure, classifyProviderFailure, isToolChoiceRejection } from "./failures.ts";
import { runtimeConfig } from "../config/runtime.ts";
import { fetchWithIdleTimeout } from "../network/idle-fetch.ts";
import { readImageDataUrl } from "../images/store.ts";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
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
  /** required 时试发 tool_choice；网关/模型拒绝则本次降级 auto。 */
  toolChoice?: "auto" | "required";
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
  const baseURL = config.baseURL ?? "https://uuapi.io/v1";
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

  const once = async (messages: ChatMessage[], tools: ChatTool[], imageContext?: { dataDir: string; conversationId: string }, signal?: AbortSignal, toolChoice?: "auto" | "required") => {
    if (config.api === "responses") return completeResponses(client, { model, reasoningEffort, messages, tools, imageContext, signal, toolChoice });
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
      stream: true,
      messages: outgoing,
      tools: wireTools,
      ...(toolChoice === "required" ? { tool_choice: "required" as const } : {}),
    }, { signal }).asResponse();
    if (!rawResponse.ok || !rawResponse.body) {
      const payload = await rawResponse.json().catch(() => ({})) as { error?: { message?: string } };
      const message = payload.error?.message || `HTTP ${rawResponse.status}`;
      throw Object.assign(new Error(message), { status: rawResponse.status });
    }
    // Text streams for display; tool_calls assemble only after the stream ends.
    let content = "";
    let finish: string | null = null;
    let refusal = false;
    const callAcc = new Map<number, AccCall>();
    for await (const data of sseDataEvents(rawResponse.body)) {
      const chunk = JSON.parse(data) as {
        choices?: {
          delta?: {
            content?: string | null;
            refusal?: string | null;
            tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
          };
          finish_reason?: string | null;
          message?: { refusal?: string | null };
        }[];
      };
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta?.content) {
        content += delta.content;
      }
      if (delta?.refusal || choice?.message?.refusal) refusal = true;
      for (const partial of delta?.tool_calls ?? []) {
        const index = typeof partial.index === "number" ? partial.index : callAcc.size;
        const current = callAcc.get(index) ?? { id: "", name: "", arguments: "" };
        if (partial.id) current.id = partial.id;
        if (partial.function?.name) current.name += partial.function.name;
        if (partial.function?.arguments) current.arguments += partial.function.arguments;
        callAcc.set(index, current);
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
    }
    if (refusal || finish === "content_filter") throw new ProviderFailure("refused", "chat_content_refused");
    if (finish === "length") throw new ProviderFailure("output_limit", "chat_output_limit");
    if (!["stop", "tool_calls"].includes(finish ?? "")) throw new ProviderFailure("invalid_response", `chat_unexpected_finish: ${finish ?? "missing"}`);
    const calls: AccCall[] = [...callAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => {
      if (call.name) call.name = byWire.get(call.name) ?? call.name;
      return call;
    });
    for (const call of calls) {
      if (!call.id.trim() || !call.name.trim()) {
        throw new ProviderFailure("invalid_response", "chat_invalid_function_call");
      }
    }
    if (finish === "stop" && calls.length) throw new ProviderFailure("invalid_response", "chat_stop_with_tool_calls");
    if (finish === "tool_calls" && !calls.length) throw new ProviderFailure("invalid_response", "chat_missing_tool_calls");
    if (!calls.length && !content.trim()) throw new ProviderFailure("invalid_response", "chat_empty_output");
    return { content, calls, finish: finish as "stop" | "tool_calls" };
  };

  return {
    complete: async (input: CompletionInput): Promise<CompletionResult> => {
      let lastError: unknown;
      let attempts = 0;
      let toolChoice = input.toolChoice;
      for (let attempt = 1; attempt <= runtimeConfig.network.maxAttempts; attempt++) {
        if (input.signal?.aborted) return stoppedResult(attempts);
        attempts = attempt;
        try {
          const { content, calls, finish } = await once(input.messages, input.tools, input.imageContext, input.signal, toolChoice);
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
          if (toolChoice === "required" && isToolChoiceRejection(error)) {
            toolChoice = undefined;
            attempt -= 1;
            continue;
          }
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
