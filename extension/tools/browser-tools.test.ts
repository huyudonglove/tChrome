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

test("capture_page element crops the element document bounds and rejects ambiguous inputs", async () => {
  const commands: any[] = [];
  globals.chrome = {
    tabs: {get: async () => ({id: 904, url: "https://example.com"})},
    scripting: {executeScript: async () => [{result: {ok: true, rect: {x: -10, y: 1800, width: 240, height: 120}}}]},
    debugger: {attach: async () => {}, sendCommand: async (_: any, name: string, params: any) => {
      commands.push([name, params]);
      if (name === "Page.getLayoutMetrics") return {cssContentSize: {x: 0, y: 0, width: 1280, height: 3000}};
      return {data: "cropped-image"};
    }},
  };
  const result = await runBrowserTool("capture_page", {mode: "element",tab: 904, selector: "#target"});
  expect(result).toMatchObject({ok: true, mime: "image/png", clipped: true, capture_rect: {x: 0, y: 1800, width: 230, height: 120}});
  expect(commands[1]).toEqual(["Page.captureScreenshot", {format: "png", fromSurface: true, captureBeyondViewport: true, clip: {x: 0, y: 1800, width: 230, height: 120, scale: 1}}]);
  expect((await runBrowserTool("capture_page", {mode: "element",tab: 904, ref: "el-test", selector: "#target"})).ok).toBe(false);
});

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
    expression: code, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true,
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

test("execute_javascript preserves full values and exceptions", async () => {
  const value = { text: "x".repeat(20000) };
  let tab = mockJavascript(async () => ({ result: { type: "object", value } }));
  expect(await runBrowserTool("execute_javascript", { tab, code: "largeResult" })).toEqual({ok: true, tab, type: "object", value});
  tab = mockJavascript(async () => ({ exceptionDetails: { text: value.text } }));
  expect(await runBrowserTool("execute_javascript", { tab, code: "throw Error()" })).toEqual({ok: false, tab, error: value.text});
});

test("execute_javascript reports protocol timeouts without retrying", async () => {
  let calls = 0;
  const tab = mockJavascript(async () => { calls++; throw new Error("Execution was terminated"); });
  expect(await runBrowserTool("execute_javascript", { tab, code: "while (true) {}" })).toEqual({
    ok: false, error: "Execution was terminated",
  });
  expect(calls).toBe(1);
});

test("native dialog detection releases a blocked page operation and accepts prompt without DOM", async () => {
  let event: any, detach: any;
  const commands: any[] = [];
  let scriptCalls = 0;
  globals.chrome = {
    tabs: {get: async () => ({id: 901, url: "https://example.com", title: "Example"}), onRemoved: {addListener() {}}},
    debugger: {
      attach: async () => {},
      onEvent: {addListener(fn: any) { event = fn; }},
      onDetach: {addListener(fn: any) { detach = fn; }},
      sendCommand: async (_target: any, method: string, params: any) => { commands.push([method, params]); },
    },
    scripting: {executeScript: () => {
      scriptCalls++;
      event({tabId: 901}, "Page.javascriptDialogOpening", {type: "prompt", message: "Name?", defaultPrompt: ""});
      return new Promise(() => {});
    }},
  };
  expect(await runBrowserTool("see_diag", {tab: 901})).toMatchObject({ok: true, dialog: {status: "unknown"}});
  expect(scriptCalls).toBe(0);
  expect(await runBrowserTool("see_page", {tab: 901})).toMatchObject({ok: false, faultCode: "dialog_open", dialog: {type: "prompt", message: "Name?"}});
  expect(await runBrowserTool("see_diag", {tab: 901})).toMatchObject({dialog: {status: "open"}});
  expect(await runBrowserTool("handle_dialog", {tab: 901, action: "accept", promptText: "Ada"})).toMatchObject({ok: true, dialog: {status: "closed"}});
  expect(commands).toContainEqual(["Page.handleJavaScriptDialog", {accept: true, promptText: "Ada"}]);
  expect(scriptCalls).toBe(1);
  detach({tabId: 901});
  expect(await runBrowserTool("see_diag", {tab: 901})).toMatchObject({dialog: {status: "unknown"}});
});

test("handle_dialog works without an opening event and surfaces missing dialog", async () => {
  let fail = false;
  globals.chrome = {
    tabs: {get: async () => ({id: 902, url: "https://example.com"})},
    debugger: {attach: async () => {}, sendCommand: async (_target: any, method: string, params: any) => {
      expect(method).toBe("Page.handleJavaScriptDialog");
      expect(params).toEqual({accept: false});
      if (fail) throw new Error("No dialog is showing");
    }},
  };
  expect(await runBrowserTool("handle_dialog", {tab: 902, action: "dismiss"})).toMatchObject({ok: true});
  fail = true;
  expect(await runBrowserTool("handle_dialog", {tab: 902, action: "dismiss"})).toMatchObject({ok: false, faultCode: "no_dialog"});
});


test("capture_page full_page captures CSS content bounds beyond viewport without resizing", async () => {
  const commands: any[] = [];
  globals.chrome = {
    tabs: {get: async () => ({id: 903, url: "https://example.com"})},
    debugger: {attach: async () => {}, sendCommand: async (_: any, method: string, params: any) => {
      commands.push([method, params]);
      if (method === "Page.getLayoutMetrics") return {cssContentSize: {x: 0, y: 0, width: 800, height: 6000}};
      if (method === "Page.captureScreenshot") return {data: "test-image"};
      throw new Error(method);
    }},
  };
  expect(await runBrowserTool("capture_page", {mode: "full_page",tab: 903})).toMatchObject({ok: true, fullPage: true, page_size: [800, 6000]});
  expect(commands[1]).toEqual(["Page.captureScreenshot", {format: "jpeg", quality: 70, captureBeyondViewport: true, fromSurface: true, clip: {x: 0, y: 0, width: 800, height: 6000, scale: 1}}]);
});

const eventBus = () => {
  const listeners = new Set<(...args: any[]) => void>();
  return { listeners, addListener: (fn: any) => listeners.add(fn), removeListener: (fn: any) => listeners.delete(fn),
    emit: (...args: any[]) => { for (const fn of [...listeners]) fn(...args); } };
};
const mockSocketBrowser = (tab: number, fail = false) => {
  const onEvent = eventBus(), onDetach = eventBus(), onRemoved = eventBus();
  const commands: string[] = [];
  globals.chrome = {
    tabs: { get: async () => ({id: tab, url: 'https://example.com'}), onRemoved },
    debugger: { onEvent, onDetach, attach: async () => {}, sendCommand: async (_: any, command: string) => {
      commands.push(command);
      if (fail && command === 'Network.enable') throw new Error('network unavailable');
    } },
  };
  return {onEvent, onDetach, onRemoved, commands};
};

test('WebSocket monitor captures both directions, isolates tabs, bounds data and cleans up on stop/restart', async () => {
  const tab = 3101;
  const {onEvent, commands} = mockSocketBrowser(tab);
  expect(await runBrowserTool('websocket_monitor', {tab, action: 'start'})).toMatchObject({ok: true, started: true});
  expect(await runBrowserTool('websocket_monitor', {tab, action: 'start'})).toMatchObject({already: true});
  expect(commands.filter(c => c === 'Network.enable')).toHaveLength(1);
  const frame = (id: number, dir: string, data: string) => onEvent.emit({tabId: id}, `Network.webSocketFrame${dir}`, {requestId: 'socket', response: {opcode: 1, payloadData: data}});
  frame(tab + 1, 'Received', 'unrelated');
  frame(tab, 'Sent', 'outbound'); frame(tab, 'Received', 'inbound');
  const read = await runBrowserTool('websocket_monitor', {tab, action: 'read'});
  expect(read.messages.map((m: any) => [m.dir, m.data])).toEqual([['out', 'outbound'], ['in', 'inbound']]);
  for (let i = 0; i < 55; i++) frame(tab, 'Received', String(i));
  frame(tab, 'Received', 'x'.repeat(17000));
  const stopped = await runBrowserTool('websocket_monitor', {tab, action: 'stop'});
  expect(stopped.messages).toHaveLength(50);
  expect(stopped.messages.at(-1)).toMatchObject({truncated: true, opcode: 1});
  expect(stopped.messages.at(-1).data).toHaveLength(16000);
  expect(onEvent.listeners.size).toBe(1); // shared dialog listener remains
  frame(tab, 'Received', 'after-stop');
  expect(await runBrowserTool('websocket_monitor', {tab, action: 'read'})).toMatchObject({monitoring: false, messages: []});
  expect(commands).not.toContain('Network.disable');
  await runBrowserTool('websocket_monitor', {tab, action: 'start'});
  expect(await runBrowserTool('websocket_monitor', {tab, action: 'read'})).toMatchObject({monitoring: true, messages: []});
  await runBrowserTool('websocket_monitor', {tab, action: 'stop'});
});

for (const reason of ['detach', 'close', 'failure']) test(`WebSocket monitor releases listeners after ${reason}`, async () => {
  const tab = reason === 'detach' ? 3102 : reason === 'close' ? 3103 : 3104;
  const {onEvent, onDetach, onRemoved} = mockSocketBrowser(tab, reason === 'failure');
  const result = await runBrowserTool('websocket_monitor', {tab, action: 'start'});
  if (reason === 'failure') expect(result.ok).toBe(false);
  else {
    expect(result.ok).toBe(true);
    if (reason === 'detach') onDetach.emit({tabId: tab});
    else onRemoved.emit(tab);
  }
  expect(onEvent.listeners.size).toBe(1);
  expect(onDetach.listeners.size).toBe(1);
  expect(onRemoved.listeners.size).toBe(1);
  expect(await runBrowserTool('websocket_monitor', {tab, action: 'read'})).toMatchObject({monitoring: false, messages: []});
});

test('service_worker_list reads registrations from the requested page and reports unsupported origins', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const scripts: number[] = [];
  const registration = {scope: 'https://example.com/app/', active: {scriptURL: 'https://example.com/sw.js'}};
  try {
    Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {serviceWorker: {getRegistrations: async () => [registration]}}});
    globals.chrome = {
      tabs: {get: async (id: number) => ({id, url: 'https://example.com'})},
      scripting: {executeScript: async ({target, func, args}: any) => {
        scripts.push(target.tabId);
        return [{result: args ? await func(...args) : {title: 'Example', url: 'https://example.com', text: ''}}];
      }},
    };
    expect(await runBrowserTool('service_worker_list', {tab: 3201})).toMatchObject({ok: true, serviceWorkers: [{scope: registration.scope, active: registration.active.scriptURL}]});
    expect(scripts.every(id => id === 3201)).toBe(true);
    Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {}});
    expect(await runBrowserTool('service_worker_list', {tab: 3201})).toMatchObject({ok: false, error: '该页面不支持 Service Worker API'});
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globals.navigator;
  }
});

test('page element IDs survive reorder and never target replacement nodes', async () => {
  const keys = ['document', 'Element', 'getComputedStyle', '__tChromePageIds', 'innerWidth', 'innerHeight'];
  const originals = keys.map(key => Object.getOwnPropertyDescriptor(globals, key));
  class Node {
    isConnected = true;
    tagName = 'BUTTON';
    clicks = 0;
    constructor(public innerText: string) {}
    getBoundingClientRect() {return {x: 0, y: 0, width: 100, height: 30, bottom: 30, right: 100, top: 0, left: 0};}
    getAttribute() {return null;}
    closest() {return null;}
    contains() {return true;}
    click() {this.clicks++;}
  }
  let nodes = [new Node('first'), new Node('second')];
  const first = nodes[0]!;
  const second = nodes[1]!;
  const counters: Record<string, number> = {};
  let closedAfterClick = false;
  try {
    delete globals.__tChromePageIds;
    globals.Element = Node;
    globals.innerWidth = 800;
    globals.innerHeight = 600;
    globals.getComputedStyle = () => ({display: 'block', visibility: 'visible', opacity: '1'});
    globals.document = {body: new Node('body'), title: 'Example', querySelectorAll: (selector: string) => selector.startsWith('header') ? [] : nodes};
    globals.chrome = {
      runtime: {sendMessage: async ({kind}: any) => ({id: `${kind === 'pageRegion' ? 'r' : 'e'}_${String(counters[kind] = (counters[kind] ?? 0) + 1).padStart(2, '0')}`})},
      tabs: {get: async () => {if (closedAfterClick) {closedAfterClick = false; return null;} return {id: 1, url: 'https://example.com'};}},
      scripting: {executeScript: async ({func, args}: any) => {
        const result = args ? await func(...args) : {title: 'Example', url: 'https://example.com'};
        if (args?.[0] === 'page.click' && result.ok) closedAfterClick = true;
        return [{result}];
      }},
    };
    const observed = await runBrowserTool('page.list_interactive_elements', {tab: 1});
    expect(observed.elements.map((el: any) => el.id)).toEqual(['e_01', 'e_02']);
    nodes.reverse();
    expect((await runBrowserTool('page.click', {tab: 1, id: 'e_01'})).ok).toBe(true);
    expect(first.clicks).toBe(1);
    expect(second.clicks).toBe(0);
    first.isConnected = false;
    nodes = [new Node('replacement'), second];
    expect((await runBrowserTool('page.click', {tab: 1, id: 'e_01'})).ok).toBe(false);
    const replacement = await runBrowserTool('page.list_interactive_elements', {tab: 1});
    expect(replacement.elements.map((el: any) => el.id)).toEqual(['e_03', 'e_02']);
    expect(replacement.elements[0].regionId).toBe('r_01');
  } finally {
    keys.forEach((key, index) => {
      if (originals[index]) Object.defineProperty(globals, key, originals[index]!);
      else delete globals[key];
    });
  }
});
