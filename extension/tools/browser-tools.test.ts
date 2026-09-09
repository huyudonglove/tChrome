import { afterEach, expect, test } from "bun:test";
import { runBrowserTool } from "./browser-tools.js";

const globals = globalThis as any;
const originalChrome = globals.chrome;
const originalIndexedDB = globals.indexedDB;
afterEach(() => {
  globals.chrome = originalChrome;
  globals.indexedDB = originalIndexedDB;
});

test("export_data downloads Unicode text through a worker-compatible data URL", async () => {
  let options: any;
  globals.chrome = { downloads: { download: async (input: any) => { options = input; return 7; } } };
  expect(await runBrowserTool("export_data", { data: "中文 & #\nnext", filename: "result.txt" })).toEqual({ ok: true, downloadId: 7 });
  expect(options.filename).toBe("result.txt");
  expect(options.url.startsWith("data:text/plain;charset=utf-8,")).toBe(true);
  expect(await (await fetch(options.url)).text()).toBe("中文 & #\nnext");
});

test("set_cookie passes Chrome SameSite enum values", async () => {
  const values: string[] = [];
  globals.chrome = { cookies: { set: async (input: any) => { values.push(input.sameSite); } } };
  for (const sameSite of [undefined, "Lax", "Strict", "None", "no_restriction", "unspecified"]) {
    await runBrowserTool("set_cookie", { url: "https://example.com", name: "test", value: "1", sameSite });
  }
  expect(values).toEqual(["lax", "lax", "strict", "no_restriction", "no_restriction", "unspecified"]);
});

test("clear_cookies uses a URL filter and retains explicit all-cookie behavior", async () => {
  const filters: any[] = [];
  globals.chrome = { cookies: { getAll: async (input: any) => { filters.push(input); return []; } } };
  await runBrowserTool("clear_cookies", { origin: "https://example.com" });
  await runBrowserTool("clear_cookies", {});
  expect(filters).toEqual([{ url: "https://example.com" }, {}]);
});

test("indexeddb delete opens a writable transaction and removes the requested key", async () => {
  const records = new Map([["key", "value"]]);
  globals.indexedDB = {
    open: () => {
      const request: any = {};
      queueMicrotask(() => request.onsuccess({ target: { result: {
        close() {},
        transaction(_store: string, mode: string) {
          return { objectStore: () => ({ delete(key: string) {
            if (mode !== "readwrite") throw new Error("ReadOnlyError");
            const deletion: any = {};
            queueMicrotask(() => { records.delete(key); deletion.onsuccess(); });
            return deletion;
          } }) };
        },
      } } }));
      return request;
    },
  };
  globals.chrome = {
    tabs: { get: async () => ({ id: 1, url: "https://example.com" }) },
    scripting: { executeScript: async ({ func, args }: any) => [{ result: args
      ? await func(...args)
      : { title: "Example", url: "https://example.com", text: "" } }] },
  };
  const result = await runBrowserTool("indexeddb", { tab: 1, action: "delete", db: "test", store: "records", key: "key" });
  expect(result.ok).toBe(true);
  expect(records.has("key")).toBe(false);
});

test("wait reports failure when the page loads but expected text never appears", async () => {
  globals.chrome = {
    tabs: { get: async () => ({ id: 7, url: "https://example.com" }) },
    scripting: { executeScript: async () => [{ result: {
      title: "Example", url: "https://example.com", text: "not ready",
    } }] },
  };
  const result = await runBrowserTool("wait", { tab: 7, text: "missing", ms: 1 });
  expect(result.ok).toBe(false);
  expect(result.error).toBe("没等到这段文字");
  expect(result.tab).toBe(7);
  expect(result.text).toBe("not ready");
});

for (const name of ["screenshot_full", "screenshot_one"]) {
  test(`${name} activates the requested background tab before capturing its window`, async () => {
    let activeTab = 99;
    let minimized = true;
    const targetTab = { id: 7, windowId: 3, url: "https://example.com" };
    const rect = { x: 10, y: 20, width: 30, height: 40 };
    globals.chrome = {
      windows: { update: async (id: number, input: any) => {
        expect(id).toBe(3);
        if (input.state === "normal") minimized = false;
      } },
      tabs: {
        get: async () => ({ ...targetTab, active: activeTab === 7 }),
        update: async (id: number, input: any) => { if (input.active) activeTab = id; },
        captureVisibleTab: async (windowId: number) => {
          expect(windowId).toBe(3);
          if (minimized) throw new Error("image readback failed");
          return `image-of-tab-${activeTab}`;
        },
      },
      scripting: { executeScript: async ({ target, args }: any) => {
        expect(target.tabId).toBe(7);
        return [{ result: args ? rect : { count: 0, last: [] } }];
      } },
    };
    const result = await runBrowserTool(name, { tab: 7, ref: "#example" });
    expect(result.ok).toBe(true);
    expect(result.tab).toBe(7);
    expect(result.image).toBe("image-of-tab-7");
    if (name === "screenshot_one") expect(result.element_rect).toEqual(rect);
  });
}
