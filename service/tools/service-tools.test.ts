import { expect, spyOn, test } from "bun:test";
import { runServiceTool } from "./service-tools.ts";

test("search parses results beyond the HTTP preview limit and skips malformed links", async () => {
  const link = (value: string) => `<a href="/?uddg=${value}&rut=x">result</a>`;
  const html = "x".repeat(9000) + link("%ZZ") + link(encodeURIComponent("https://example.com/first"))
    + link(encodeURIComponent("https://example.com/first")) + link(encodeURIComponent("https://example.com/second"));
  const mock = spyOn(globalThis, "fetch").mockImplementation((async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(html)) as typeof fetch);
  try {
    expect(await runServiceTool("/tmp", "web_search", { query: "demo" })).toEqual({
      ok: true, query: "demo", urls: ["https://example.com/first", "https://example.com/second"],
    });
    const ordinary = await runServiceTool("/tmp", "send_http", { url: "https://example.com" });
    expect((ordinary as { text: string }).text.length).toBe(8000);
  } finally { mock.mockRestore(); }
});

test.each([429, 503])("search HTTP %s remains a failure instead of an empty success", async (status) => {
  const mock = spyOn(globalThis, "fetch").mockImplementation((async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("unavailable", { status })) as typeof fetch);
  try {
    expect(await runServiceTool("/tmp", "web_search", { query: "demo" })).toMatchObject({ ok: false, status, urls: [] });
  } finally { mock.mockRestore(); }
});

test("search network failure is returned to the loop as a tool error", async () => {
  const mock = spyOn(globalThis, "fetch").mockImplementation((async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { throw new Error("network unavailable"); }) as typeof fetch);
  try {
    expect(await runServiceTool("/tmp", "web_search", { query: "demo" })).toMatchObject({ ok: false, error: "network unavailable" });
  } finally { mock.mockRestore(); }
});


test("HTTP probe distinguishes reachable error responses and skips their body", async () => {
  const response = new Response(new ReadableStream({ start() {} }), { status: 503, headers: { "retry-after": "10" } });
  Object.defineProperty(response, "url", { value: "https://example.com/final" });
  const mock = spyOn(globalThis, "fetch").mockResolvedValue(response);
  try {
    const result = await runServiceTool("/tmp", "probe_http", { url: "https://example.com", method: "HEAD" });
    expect(result).toMatchObject({ ok: false, reachable: true, status: 503, url: "https://example.com/final", headers: { "retry-after": "10" } });
    expect(result).not.toHaveProperty("text");
    expect(mock.mock.calls[0]?.[1]?.method).toBe("HEAD");
  } finally { mock.mockRestore(); }
});

test("HTTP probe validates its target and method before sending and reports network errors", async () => {
  const mock = spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unavailable"));
  try {
    for (const input of [{}, { url: "file:///tmp/test" }, { url: "https://example.com", method: "POST" }]) {
      expect(await runServiceTool("/tmp", "probe_http", input)).toMatchObject({ ok: false, error: expect.any(String) });
    }
    expect(mock).not.toHaveBeenCalled();
    expect(await runServiceTool("/tmp", "probe_http", { url: "https://example.com" })).toMatchObject({
      ok: false, reachable: false, url: "https://example.com", error: "network unavailable",
    });
    expect(mock.mock.calls[0]?.[1]?.method).toBe("GET");
  } finally { mock.mockRestore(); }
});

test("HTTP execution rejects invalid link addresses without making a request", async () => {
  const mock = spyOn(globalThis, "fetch").mockImplementation((async () => new Response("ok")) as unknown as typeof fetch);
  try {
    for (const url of [true, undefined, "file:///tmp/a", "/path", "https://example.com:bad/", "https://"]) {
      expect(await runServiceTool("/tmp", "send_http", { url })).toMatchObject({ ok: false, error: expect.any(String) });
    }
    expect(mock).not.toHaveBeenCalled();
  } finally { mock.mockRestore(); }
});

test("batch HTTP validates every address before fetching and preserves partial failures", async () => {
  const mock = spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
    if (url.endsWith('/fail')) throw new Error("connection reset");
    return new Response("ok");
  }) as unknown as typeof fetch);
  try {
    for (const urls of [undefined, [], "https://example.com", [true], ["https://example.com", "file:///tmp/a"], Array(6).fill("https://example.com")]) {
      expect(await runServiceTool("/tmp", "send_http_batch", { urls })).toMatchObject({ ok: false, results: [] });
    }
    expect(mock).not.toHaveBeenCalled();
    const result = await runServiceTool("/tmp", "send_http_batch", { urls: ["https://example.com/a", "https://example.com/fail", "https://example.com/b"] }) as {ok:boolean;results:{ok:boolean;error?:string}[]};
    expect(result.ok).toBe(false);
    expect(result.results.map(row => row.ok)).toEqual([true, false, true]);
    expect(result.results[1]!.error).toBe("connection reset");
    expect(mock.mock.calls.map(call => call[0])).toEqual(["https://example.com/a", "https://example.com/fail", "https://example.com/b"]);
  } finally { mock.mockRestore(); }
});

test('retired service names reject calls without executing network requests', async () => {
  const mock = spyOn(globalThis, 'fetch');
  try {
    for (const name of ['web_search_free', 'deep_search', 'search_plus', 'osint_intel', 'api_execute', 'api_discover', 'api_manage']) {
      expect(await runServiceTool('/tmp', name, {query: 'demo', url: 'https://example.com'})).toEqual({ok: false, error: `未接执行器 ${name}`});
    }
    expect(mock).not.toHaveBeenCalled();
  } finally { mock.mockRestore(); }
});
