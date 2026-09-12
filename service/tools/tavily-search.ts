import { tavily, type TavilyClientOptions } from "@tavily/core";
import { runtimeConfig } from "../config/runtime.ts";

export async function runTavilySearch(
  input: Record<string, unknown>,
  config: Pick<TavilyClientOptions, "apiKey" | "apiBaseURL"> = {},
) {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const maxResults = input.maxResults ?? 5;
  if (!query || typeof input.query !== "string" || input.query.length > 4000
    || typeof maxResults !== "number" || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) {
    return { ok: false, faultCode: "invalid_arguments", error: "query 必须为 1–4000 字符的非空搜索词，maxResults 必须为 1–10 的整数。" };
  }
  const apiKey = (config.apiKey ?? Bun.env.TAVILY_API_KEY)?.trim();
  if (!apiKey) return { ok: false, faultCode: "tavily_key_missing", error: "请在服务端配置 TAVILY_API_KEY。" };
  try {
    const response = await tavily({ ...config, apiKey }).search(query, {
      searchDepth: "advanced", maxResults, timeout: runtimeConfig.sdk.tavilyTimeoutSeconds,
      includeAnswer: false, includeRawContent: false, includeImages: false,
    });
    if (!Array.isArray(response.results) || response.results.some(item =>
      typeof item.title !== "string" || typeof item.url !== "string"
      || typeof item.content !== "string" || typeof item.score !== "number" || !Number.isFinite(item.score))) {
      return { ok: false, faultCode: "tavily_invalid_response", error: "Tavily 返回的搜索结果格式无效。" };
    }
    const results = response.results.slice(0, maxResults).map(item => ({
      title: item.title, url: item.url, content: item.content.slice(0, 4000), score: item.score,
      ...(item.content.length > 4000 ? { truncated: true } : {}),
    }));
    return { ok: true, query, searchDepth: "advanced", results, urls: results.map(item => item.url) };
  } catch (error) {
    // SDK errors can contain request credentials or upstream response bodies.
    const timeout = error instanceof Error && /timed?\s*out|timeout/i.test(error.message);
    return { ok: false, faultCode: timeout ? "tavily_timeout" : "tavily_request_failed",
      error: timeout ? "Tavily 搜索超时，请稍后重试。" : "Tavily 搜索失败，请检查网络连接、API Key 或账户额度。" };
  }
}
