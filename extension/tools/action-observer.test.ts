import { afterEach, expect, test } from "bun:test";
import {
  beginActionObserve,
  endActionObserve,
  initActionObserver,
  resetActionObserverForTests,
  summarizeDomDiff,
} from "./action-observer.js";

const globals = globalThis as any;
const originalChrome = globals.chrome;

const listeners: any[] = [];
const detachListeners: any[] = [];

/** Mutated per test: executeScript results by call purpose. */
let alertTexts: string[] = [];
let htmlSnapshots: string[] = [];
let htmlCall = 0;
let alertCall = 0;

const setupChrome = () => {
  listeners.length = 0;
  detachListeners.length = 0;
  alertTexts = [];
  htmlSnapshots = [];
  htmlCall = 0;
  alertCall = 0;
  globals.chrome = {
    debugger: {
      onEvent: { addListener: (fn: any) => listeners.push(fn) },
      onDetach: { addListener: (fn: any) => detachListeners.push(fn) },
      attach: async () => {},
      sendCommand: async (_tab: any, cmd: string) => {
        if (cmd === "Network.getResponseBody") return { body: "server exploded HTML".repeat(20) };
        return {};
      },
    },
    tabs: {
      get: async (id: number) => ({ id, url: "https://example.com/page" }),
      onRemoved: { addListener: () => {}, removeListener: () => {} },
      onUpdated: { addListener: () => {}, removeListener: () => {} },
    },
    scripting: {
      executeScript: async ({ func, args }: any) => {
        const selector = Array.isArray(args) ? args[0] : undefined;
        // alert sampler uses selector arg with role=alert etc.
        if (typeof selector === "string" && selector.includes("role=")) {
          const texts = alertTexts[alertCall++] ?? alertTexts.at(-1) ?? [];
          return [{ result: texts }];
        }
        // clean html sampler has numeric cap arg
        if (typeof selector === "number") {
          const html = htmlSnapshots[htmlCall++] ?? htmlSnapshots.at(-1) ?? null;
          return [{ result: html }];
        }
        try {
          return [{ result: func(...(args ?? [])) }];
        } catch {
          return [{ result: null }];
        }
      },
    },
  };
};

afterEach(() => {
  globals.chrome = originalChrome;
  resetActionObserverForTests();
});

test("observer attaches domains, drains 4xx and console errors sparsely", async () => {
  setupChrome();
  initActionObserver();
  expect(listeners.length).toBe(1);

  const session = await beginActionObserve(7);
  listeners[0]!({ tabId: 7 }, "Network.responseReceived", {
    requestId: "req_1",
    response: { status: 400, url: "https://api.example.com/save" },
  });
  listeners[0]!({ tabId: 7 }, "Runtime.exceptionThrown", {
    exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: boom" } },
  });
  listeners[0]!({ tabId: 7 }, "Network.responseReceived", {
    requestId: "ok",
    response: { status: 200, url: "https://api.example.com/ok" },
  });

  const out = await endActionObserve(session, { ok: true, clicked: true, id: "e_12" });
  expect(out.ok).toBe(true);
  expect(out.effects?.network?.[0]).toMatchObject({ status: 400, url: "https://api.example.com/save" });
  expect(String(out.effects.network[0].body ?? "").length).toBeLessThanOrEqual(150);
  expect(out.effects.console?.[0]).toMatchObject({ level: "error", text: "TypeError: boom" });
  expect(out.effects.nav).toBeUndefined();
});

test("clean action returns no effects key at all", async () => {
  setupChrome();
  initActionObserver();
  const session = await beginActionObserve(9);
  const out = await endActionObserve(session, { ok: true, clicked: true, id: "e_1" });
  expect(out).toEqual({ ok: true, clicked: true, id: "e_1" });
  expect(Object.hasOwn(out, "effects")).toBe(false);
});

test("url change attaches effects.nav only", async () => {
  setupChrome();
  initActionObserver();
  const session = await beginActionObserve(3);
  globals.chrome.tabs.get = async (id: number) => ({ id, url: "https://example.com/dashboard" });
  const out = await endActionObserve(session, { ok: true });
  expect(out.effects?.nav).toEqual({ urlChanged: true, to: "https://example.com/dashboard" });
  expect(out.effects?.network).toBeUndefined();
});

test("result.delta merges into effects.delta and is stripped from top level", async () => {
  setupChrome();
  initActionObserver();
  const session = await beginActionObserve(4);
  const out = await endActionObserve(session, {
    ok: true,
    id: "e_01",
    delta: { ariaInvalid: true, validationMessage: "请输入合法的邮箱格式" },
  });
  expect(out.effects?.delta).toEqual({ ariaInvalid: true, validationMessage: "请输入合法的邮箱格式" });
  expect(Object.hasOwn(out, "delta")).toBe(false);
});

test("loadingFailed is captured as network error without status", async () => {
  setupChrome();
  initActionObserver();
  const session = await beginActionObserve(5);
  listeners[0]!({ tabId: 5 }, "Network.loadingFailed", { errorText: "net::ERR_CONNECTION_RESET" });
  const out = await endActionObserve(session, { ok: true });
  expect(out.effects?.network?.[0]).toMatchObject({ error: "net::ERR_CONNECTION_RESET" });
});

test("cleaned HTML diff fills effects.domChange only when structure changed", async () => {
  setupChrome();
  initActionObserver();
  htmlSnapshots = [
    "<html><body><div id=\"app\">old title</div></body></html>",
    "<html><body><div id=\"app\">old title</div><p>saved ok</p></body></html>",
  ];
  const session = await beginActionObserve(11);
  const out = await endActionObserve(session, { ok: true });
  expect(typeof out.effects?.domChange).toBe("string");
  expect(String(out.effects.domChange)).toContain("+");
  expect(String(out.effects.domChange)).toContain("saved ok");
});

test("identical cleaned HTML omits domChange", async () => {
  setupChrome();
  initActionObserver();
  const html = "<html><body><div>same</div></body></html>";
  htmlSnapshots = [html, html];
  const session = await beginActionObserve(12);
  const out = await endActionObserve(session, { ok: true });
  expect(Object.hasOwn(out, "effects")).toBe(false);
});

test("summarizeDomDiff handles equal, insert, and delete", () => {
  expect(summarizeDomDiff("abc", "abc")).toBeNull();
  expect(summarizeDomDiff(null, "x")).toBeNull();
  const added = summarizeDomDiff("ab", "aXXb");
  expect(added).toContain("+");
  const removed = summarizeDomDiff("aYYb", "ab");
  expect(removed).toContain("-");
});
