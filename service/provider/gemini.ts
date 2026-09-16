import { setTimeout as sleep } from "node:timers/promises";
import { ProviderFailure, classifyProviderFailure } from "./failures.ts";
import { runtimeConfig } from "../config/runtime.ts";
import { fetchWithIdleTimeout } from "../network/idle-fetch.ts";
import { readImageDataUrl } from "../images/store.ts";
import { parseToolArguments } from "../tools/arguments.ts";
import type { ChatMessage, ChatTool, CompletionResult, ProviderGrounding, ToolCall, ToolCallFault } from "../types.ts";

export type GeminiConfig = {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  proxy?: string;
  googleSearch?: boolean;
};

type CompletionInput = {
  messages: ChatMessage[];
  tools: ChatTool[];
  imageContext?: { dataDir: string; conversationId: string };
  signal?: AbortSignal;
};

type GeminiPart = {
  text?: string;
  functionCall?: { name: string; args?: unknown };
  inlineData?: { mimeType: string; data: string };
};

type GeminiResponse = {
  candidates?: {
    finishReason?: string;
    content?: { role?: string; parts?: GeminiPart[] };
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: { web?: { uri?: string; title?: string } }[];
      searchEntryPoint?: { renderedContent?: string };
    };
  }[];
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
};

const stoppedResult = (attempts: number): CompletionResult => ({
  finish: "error", content: "", toolCalls: [], attempts,
  parseOk: false, schemaOk: false, faultCode: "stopped", missing: [],
});

const keyMissing = (): CompletionResult => ({
  finish: "error", content: "", toolCalls: [], attempts: 0,
  parseOk: false, schemaOk: false, faultCode: "provider_key_missing", missing: [],
});

const parseCalls = (calls: { id: string; name: string; arguments: string }[]) => {
  const toolCalls: ToolCall[] = [];
  const faults: ToolCallFault[] = [];
  for (const call of calls) {
    if (!call.id && !call.name) continue;
    const parsed = parseToolArguments(call.arguments);
    if (!parsed.ok) {
      faults.push({ callId: call.id, name: call.name, rawArguments: call.arguments, detail: parsed.detail });
      continue;
    }
    toolCalls.push({ id: call.id, name: call.name, arguments: parsed.value });
  }
  return { toolCalls, faults, parseOk: faults.length === 0 };
};

function finishFailure(reason: string | undefined, blockReason: string | undefined): ProviderFailure | null {
  if (blockReason) return new ProviderFailure("refused", `gemini_block: ${blockReason}`);
  if (!reason) return null;
  if (reason === "MAX_TOKENS") return new ProviderFailure("output_limit", "gemini_output_limit");
  if (reason === "SAFETY" || reason === "RECITATION" || reason === "BLOCKLIST" || reason === "PROHIBITED_CONTENT") {
    return new ProviderFailure("refused", `gemini_refused: ${reason}`);
  }
  if (reason === "STOP") return null;
  return new ProviderFailure("invalid_response", `gemini_unexpected_finish: ${reason}`);
}

function parseGrounding(metadata: NonNullable<GeminiResponse["candidates"]>[number]["groundingMetadata"]): ProviderGrounding | undefined {
  if (!metadata) return undefined;
  const queries = metadata.webSearchQueries?.filter((query): query is string => typeof query === "string" && Boolean(query.trim())) ?? [];
  const sources = (metadata.groundingChunks ?? [])
    .map((chunk) => chunk.web)
    .filter((web): web is { uri: string; title?: string } => typeof web?.uri === "string" && Boolean(web.uri))
    .map((web) => ({ title: web.title || web.uri, uri: web.uri }));
  if (!queries.length && !sources.length) return undefined;
  return { name: "google_search", queries, sources };
}

export function createGeminiProvider(config: GeminiConfig = {}) {
  const apiKey = config.apiKey ?? Bun.env.GEMINI_API_KEY;
  const baseURL = (config.baseURL ?? Bun.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  const model = config.model ?? Bun.env.GEMINI_MODEL ?? "gemini-3.8-flash";
  const proxy = config.proxy;
  const googleSearch = config.googleSearch ?? Bun.env.GEMINI_GOOGLE_SEARCH !== "0";
  if (!apiKey) {
    return { complete: async (input: CompletionInput) => input.signal?.aborted ? stoppedResult(0) : keyMissing() };
  }

  const once = async (messages: ChatMessage[], tools: ChatTool[], imageContext?: CompletionInput["imageContext"]) => {
    const system = messages.find((message) => message.role === "system")?.content ?? "";
    const user = messages.find((message) => message.role === "user");
    if (!user) throw new ProviderFailure("invalid_response", "gemini_missing_user_message");

    const parts: GeminiPart[] = [{ text: user.content }];
    for (const image of user.images ?? []) {
      if (!imageContext) throw new Error("图片请求缺少有效会话上下文");
      parts.push({ text: `附图：${image.id}${image.callId ? `，callId=${image.callId}` : ""}，${image.path}（${image.width}×${image.height}）` });
      const dataUrl = readImageDataUrl(imageContext.dataDir, imageContext.conversationId, image);
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) throw new ProviderFailure("invalid_response", "gemini_invalid_image_data");
      parts.push({ inlineData: { mimeType: match[1]!, data: match[2]! } });
    }

    const functionDeclarations = tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    }));
    const requestTools = [
      ...(googleSearch ? [{ google_search: {} }] : []),
      ...(functionDeclarations.length ? [{ functionDeclarations }] : []),
    ];

    const body = {
      contents: [{ role: "user", parts }],
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(requestTools.length ? { tools: requestTools } : {}),
    };

    const response = await fetchWithIdleTimeout(
      `${baseURL}/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(body),
        ...(proxy ? { proxy } : {}),
      } as RequestInit,
    );
    const payload = await response.json() as GeminiResponse;
    if (!response.ok) {
      const status = response.status;
      const message = payload.error?.message || payload.error?.status || `HTTP ${status}`;
      const error = Object.assign(new Error(message.replaceAll(apiKey, "[REDACTED]")), { status });
      throw error;
    }
    if (payload.error) {
      const status = Number(payload.error.code ?? 500);
      const message = (payload.error.message || payload.error.status || "gemini_error").replaceAll(apiKey, "[REDACTED]");
      throw Object.assign(new Error(message), { status });
    }

    const candidate = payload.candidates?.[0];
    if (!candidate) {
      const blockReason = payload.promptFeedback?.blockReason;
      if (blockReason) throw new ProviderFailure("refused", `gemini_block: ${blockReason}`);
      throw new ProviderFailure("invalid_response", "gemini_missing_candidate");
    }
    const failure = finishFailure(candidate.finishReason, payload.promptFeedback?.blockReason);
    if (failure) throw failure;

    const text: string[] = [];
    const calls: { id: string; name: string; arguments: string }[] = [];
    let index = 0;
    for (const part of candidate.content?.parts ?? []) {
      if (typeof part.text === "string" && part.text) text.push(part.text);
      if (part.functionCall) {
        const name = part.functionCall.name;
        if (typeof name !== "string" || !name.trim()) {
          throw new ProviderFailure("invalid_response", "gemini_invalid_function_call");
        }
        index += 1;
        calls.push({
          id: `gem_call_${String(index).padStart(2, "0")}`,
          name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        });
      }
    }
    const content = text.join("\n").trim();
    const grounding = parseGrounding(candidate.groundingMetadata);
    if (!calls.length && !content && !grounding) throw new ProviderFailure("invalid_response", "gemini_empty_output");
    // Grounding stays out of content and toolCalls; Runtime records it as evidence only.
    return { content, calls, grounding, finish: calls.length ? "tool_calls" as const : "stop" as const };
  };

  return {
    complete: async (input: CompletionInput): Promise<CompletionResult> => {
      let lastError: unknown;
      let attempts = 0;
      for (let attempt = 1; attempt <= runtimeConfig.network.maxAttempts; attempt++) {
        if (input.signal?.aborted) return stoppedResult(attempts);
        attempts = attempt;
        try {
          const { content, calls, finish, grounding } = await once(input.messages, input.tools, input.imageContext);
          if (input.signal?.aborted) return stoppedResult(attempts);
          if (finish === "stop") {
            return {
              finish: "stop", content, toolCalls: [], ...(grounding ? { grounding } : {}), attempts: attempt,
              parseOk: true, schemaOk: true, faultCode: null, missing: [],
            };
          }
          const parsed = parseCalls(calls);
          if (!parsed.parseOk) {
            return {
              finish: "tool_calls", content, toolCalls: parsed.toolCalls, ...(grounding ? { grounding } : {}), attempts: attempt,
              parseOk: false, schemaOk: false, faultCode: "arguments_not_json", missing: [],
              toolCallFaults: parsed.faults, badName: parsed.faults[0]?.name,
              detail: parsed.faults.map((fault) => `${fault.name}: ${fault.detail}`).join("; "),
            };
          }
          return {
            finish: "tool_calls", content, toolCalls: parsed.toolCalls, ...(grounding ? { grounding } : {}), attempts: attempt,
            parseOk: true, schemaOk: true, faultCode: null, missing: [],
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
        ? Number((lastError as { status: number }).status) : 0;
      return {
        finish: "error", content: "", toolCalls: [], attempts,
        parseOk: false, schemaOk: false,
        faultCode: classifyProviderFailure(lastError).faultCode,
        detail: `status=${status}; ${lastError instanceof Error ? lastError.message.replaceAll(apiKey, "[REDACTED]") : "unknown provider error"}`,
        missing: [],
      };
    },
  };
}
