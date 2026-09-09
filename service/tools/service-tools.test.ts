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
