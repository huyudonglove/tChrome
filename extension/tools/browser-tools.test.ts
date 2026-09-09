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

let javascriptTab = 2000;
const mockJavascript = (sendCommand: (...args: any[]) => Promise<any>, attach = async (..._args: any[]) => {}) => {
  const tab = ++javascriptTab;
  globals.chrome = {
    tabs: { get: async () => ({ id: tab, url: "https://example.com" }) },
    debugger: { attach, sendCommand },
  };
  return tab;
};

test("execute_javascript evaluates in the page through CDP and awaits structured results", async () => {
  const attachments: any[] = [];
  let request: any[] = [];
  const tab = mockJavascript(async (...args) => {
    request = args;
    return { result: { type: "object", value: { title: "中文", count: 3, items: [true, null] } } };
  }, async (...args) => { attachments.push(args); });
  const code = "Promise.resolve({title: document.title, count: 3, items: [true, null]})";
  expect(await runBrowserTool("execute_javascript", { tab, code })).toEqual({
    ok: true, tab, type: "object", value: { title: "中文", count: 3, items: [true, null] },
  });
  expect(attachments).toEqual([[{ tabId: tab }, "1.3"]]);
  expect(request).toEqual([{ tabId: tab }, "Runtime.evaluate", {
    expression: code, awaitPromise: true, returnByValue: true, timeout: 5000, allowUnsafeEvalBlockedByCSP: true,
  }]);
  await runBrowserTool("execute_javascript", { tab, code });
  expect(attachments).toHaveLength(1);
});

for (const remote of [{ type: "undefined" }, { type: "number", unserializableValue: "NaN" },
  { type: "number", unserializableValue: "-0" }, { type: "bigint", unserializableValue: "42n" },
  { type: "object", subtype: "null", value: null }]) {
  test(`execute_javascript preserves ${remote.unserializableValue || remote.subtype || remote.type}`, async () => {
    const tab = mockJavascript(async () => ({ result: remote }));
    const result = await runBrowserTool("execute_javascript", { tab, code: "value" });
    expect(result).toEqual({ ok: true, tab, type: remote.type,
      ...(Object.hasOwn(remote, "value") ? { value: remote.value } : {}),
      ...(remote.unserializableValue ? { unserializableValue: remote.unserializableValue } : {}),
    });
  });
}

test("execute_javascript surfaces thrown errors and rejected promises", async () => {
  const tab = mockJavascript(async () => ({
    result: { type: "object" },
    exceptionDetails: { text: "Uncaught (in promise)", exception: { description: "Error: rejected\n at page:1" } },
  }));
  expect(await runBrowserTool("execute_javascript", { tab, code: "Promise.reject(Error('rejected'))" })).toEqual({
    ok: false, tab, error: "Error: rejected\n at page:1",
  });
});

test("execute_javascript reports attach failure without evaluating", async () => {
  let calls = 0;
  const tab = mockJavascript(async () => { calls++; }, async () => { throw new Error("Another debugger is already attached"); });
  expect(await runBrowserTool("execute_javascript", { tab, code: "counter++" })).toEqual({
    ok: false, error: "Another debugger is already attached",
  });
  expect(calls).toBe(0);
});

test("execute_javascript never replays side effects after debugger disconnect", async () => {
  let attachments = 0;
  let calls = 0;
  const tab = mockJavascript(async () => { calls++; throw new Error("Debugger is not attached"); }, async () => { attachments++; });
  expect((await runBrowserTool("execute_javascript", { tab, code: "counter++" })).ok).toBe(false);
  expect(calls).toBe(1);
  expect(attachments).toBe(1);
  await runBrowserTool("execute_javascript", { tab, code: "counter" });
  expect(attachments).toBe(2);
});

test("execute_javascript bounds large values and labels previews", async () => {
  const value = { text: "x".repeat(20000) };
  const tab = mockJavascript(async () => ({ result: { type: "object", value } }));
  const result = await runBrowserTool("execute_javascript", { tab, code: "largeResult" });
  expect(result.ok).toBe(true);
  expect(result.truncated).toBe(true);
  expect(result.totalChars).toBe(JSON.stringify(value).length);
  expect(result.valuePreview).toBe(JSON.stringify(value).slice(0, 16000));
  expect(Object.hasOwn(result, "value")).toBe(false);
});

test("execute_javascript keeps large exceptions failures and bounds their output", async () => {
  const tab = mockJavascript(async () => ({ exceptionDetails: { text: "x".repeat(20000) } }));
  const result = await runBrowserTool("execute_javascript", { tab, code: "throw Error()" });
  expect(result.ok).toBe(false);
  expect(result.truncated).toBe(true);
  expect(result.error).toHaveLength(16000);
});

test("execute_javascript reports protocol timeouts without retrying", async () => {
  let calls = 0;
  const tab = mockJavascript(async () => { calls++; throw new Error("Execution was terminated"); });
  expect(await runBrowserTool("execute_javascript", { tab, code: "while (true) {}" })).toEqual({
    ok: false, error: "Execution was terminated",
  });
  expect(calls).toBe(1);
});

test("execute_javascript bounds pending promises without claiming cancellation or replaying", async () => {
  const originalSetTimeout = globals.setTimeout;
  const originalClearTimeout = globals.clearTimeout;
  let timeout: (() => void) | undefined;
  let cleared = false;
  let calls = 0;
  globals.setTimeout = (callback: () => void, ms: number) => {
    expect(ms).toBe(8000);
    timeout = callback;
    return 123;
  };
  globals.clearTimeout = (id: number) => { expect(id).toBe(123); cleared = true; };
  try {
    const tab = mockJavascript(async () => { calls++; return new Promise(() => {}); });
    const pending = runBrowserTool("execute_javascript", { tab, code: "new Promise(() => {})" });
    for (let i = 0; i < 10 && !timeout; i++) await Promise.resolve();
    expect(timeout).toBeDefined();
    timeout!();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("执行状态未知");
    expect(result.error).toContain("脚本可能仍在继续");
    expect(calls).toBe(1);
    expect(cleared).toBe(true);
  } finally {
    globals.setTimeout = originalSetTimeout;
    globals.clearTimeout = originalClearTimeout;
  }
});
