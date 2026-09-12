import { expect, test } from "bun:test";
import { runTavilySearch } from "./tavily-search.ts";
import { runServiceTool } from "./service-tools.ts";

test("Tavily SDK sends advanced search and returns bounded evidence without raw upstream data", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    expect(new URL(request.url).pathname).toBe("/search");
    expect(request.headers.get("authorization")).toBe("Bearer test-only-key");
    requests.push(await request.json());
    return Response.json({ images: [], response_time: 0.1, results: [
      { title: "Guide", url: "https://example.com", content: "x".repeat(4100), score: 0.9, raw_content: "excluded" },
      { title: "More", url: "https://example.org", content: "short", score: 0.8 },
    ] });
  } });
  try {
    const result = await runTavilySearch({ query: "  browser tools  ", maxResults: 1 }, { apiKey: "test-only-key", apiBaseURL: `http://127.0.0.1:${server.port}` });
    expect(requests).toEqual([{ query: "browser tools", search_depth: "advanced", max_results: 1,
      include_answer: false, include_raw_content: false, include_images: false }]);
    expect(result).toEqual({ ok: true, query: "browser tools", searchDepth: "advanced", urls: ["https://example.com"],
      results: [{ title: "Guide", url: "https://example.com", content: "x".repeat(4000), score: 0.9, truncated: true }] });
  } finally { server.stop(true); }
});

test("Tavily validates inputs and missing credentials before sending a request", async () => {
  for (const input of [{}, { query: " " }, { query: "x".repeat(4001) }, { query: "x", maxResults: 0 }, { query: "x", maxResults: 1.5 }]) {
    expect(await runTavilySearch(input, { apiKey: "" })).toMatchObject({ ok: false, faultCode: "invalid_arguments" });
  }
  expect(await runTavilySearch({ query: "x" }, { apiKey: "" })).toMatchObject({ ok: false, faultCode: "tavily_key_missing" });
  // The production dispatcher reaches the Tavily executor, without a browser bridge.
  expect(await runServiceTool("/tmp", "tavily_search", { query: " " })).toMatchObject({ ok: false, faultCode: "invalid_arguments" });
});

test("Tavily defaults to five results and distinguishes empty success from failures without leaking secrets", async () => {
  let mode = "empty";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    expect((await request.json()).max_results).toBe(5);
    if (mode === "error") return Response.json({ detail: { error: "test-only-key upstream secret" } }, { status: 401 });
    return Response.json({ images: [], results: mode === "empty" ? [] : [{ title: "bad" }] });
  } });
  const config = { apiKey: "test-only-key", apiBaseURL: `http://127.0.0.1:${server.port}` };
  try {
    expect(await runTavilySearch({ query: "test" }, config)).toMatchObject({ ok: true, results: [], urls: [] });
    mode = "malformed";
    expect(await runTavilySearch({ query: "test" }, config)).toMatchObject({ ok: false, faultCode: "tavily_invalid_response" });
    mode = "error";
    const failed = await runTavilySearch({ query: "test" }, config);
    expect(failed).toMatchObject({ ok: false, faultCode: "tavily_request_failed" });
    expect(JSON.stringify(failed)).not.toContain("test-only-key");
    expect(JSON.stringify(failed)).not.toContain("upstream secret");
  } finally { server.stop(true); }
});
