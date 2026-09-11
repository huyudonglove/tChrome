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
