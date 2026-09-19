import { afterEach, expect, test } from "bun:test";
import { readOpenTabs, runBrowserTool } from "./browser-tools.js";

const globals = globalThis as any;
const originalChrome = globals.chrome;
const originalIndexedDB = globals.indexedDB;
const originalCreateImageBitmap = globals.createImageBitmap;
afterEach(() => {
  globals.chrome = originalChrome;
  globals.indexedDB = originalIndexedDB;
  globals.createImageBitmap = originalCreateImageBitmap;
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
  const result = await runBrowserTool("indexeddb", { tabId: 1, action: "delete", db: "test", store: "records", key: "key" });
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
  const result = await runBrowserTool("wait", { tabId: 7, text: "missing", ms: 1 });
  expect(result.ok).toBe(false);
  expect(result.error).toBe("没等到这段文字");
  expect(result.tabId).toBe(7);
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
  const result = await runBrowserTool("capture_page", {mode: "element",tabId: 904, selector: "#target"});
  expect(result).toMatchObject({ok: true, mime: "image/png", clipped: true, capture_rect: {x: 0, y: 1800, width: 230, height: 120}});
  expect(commands[1]).toEqual(["Page.captureScreenshot", {format: "png", fromSurface: true, captureBeyondViewport: true, clip: {x: 0, y: 1800, width: 230, height: 120, scale: 1}}]);
  expect((await runBrowserTool("capture_page", {mode: "element",tabId: 904, ref: "el-test", selector: "#target"})).ok).toBe(false);
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
  expect(await runBrowserTool("execute_javascript", { tabId: tab, code })).toEqual({
    ok: true, tabId: tab, type: "object", value: { title: "中文", count: 3, items: [true, null] },
  });
  expect(attachments).toEqual([[{ tabId: tab }, "1.3"]]);
  expect(request).toEqual([{ tabId: tab }, "Runtime.evaluate", {
    expression: code, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true,
  }]);
  await runBrowserTool("execute_javascript", { tabId: tab, code });
  expect(attachments).toHaveLength(1);
});

for (const remote of [{ type: "undefined" }, { type: "number", unserializableValue: "NaN" },
  { type: "number", unserializableValue: "-0" }, { type: "bigint", unserializableValue: "42n" },
  { type: "object", subtype: "null", value: null }]) {
  test(`execute_javascript preserves ${remote.unserializableValue || remote.subtype || remote.type}`, async () => {
    const tab = mockJavascript(async () => ({ result: remote }));
    const result = await runBrowserTool("execute_javascript", { tabId: tab, code: "value" });
    expect(result).toEqual({ ok: true, tabId: tab, type: remote.type,
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
  expect(await runBrowserTool("execute_javascript", { tabId: tab, code: "Promise.reject(Error('rejected'))" })).toEqual({
    ok: false, tabId: tab, error: "Error: rejected\n at page:1",
  });
});

test("execute_javascript reports attach failure without evaluating", async () => {
  let calls = 0;
  const tab = mockJavascript(async () => { calls++; }, async () => { throw new Error("Another debugger is already attached"); });
  expect(await runBrowserTool("execute_javascript", { tabId: tab, code: "counter++" })).toEqual({
    ok: false, error: "Another debugger is already attached",
  });
  expect(calls).toBe(0);
});

test("execute_javascript never replays side effects after debugger disconnect", async () => {
  let attachments = 0;
  let calls = 0;
  const tab = mockJavascript(async () => { calls++; throw new Error("Debugger is not attached"); }, async () => { attachments++; });
  expect((await runBrowserTool("execute_javascript", { tabId: tab, code: "counter++" })).ok).toBe(false);
  expect(calls).toBe(1);
  expect(attachments).toBe(1);
  await runBrowserTool("execute_javascript", { tabId: tab, code: "counter" });
  expect(attachments).toBe(2);
});

test("execute_javascript preserves full values and exceptions", async () => {
  const value = { text: "x".repeat(20000) };
  let tab = mockJavascript(async () => ({ result: { type: "object", value } }));
  expect(await runBrowserTool("execute_javascript", { tabId: tab, code: "largeResult" })).toEqual({ok: true, tabId: tab, type: "object", value});
  tab = mockJavascript(async () => ({ exceptionDetails: { text: value.text } }));
  expect(await runBrowserTool("execute_javascript", { tabId: tab, code: "throw Error()" })).toEqual({ok: false, tabId: tab, error: value.text});
});

test("execute_javascript reports protocol timeouts without retrying", async () => {
  let calls = 0;
  const tab = mockJavascript(async () => { calls++; throw new Error("Execution was terminated"); });
  expect(await runBrowserTool("execute_javascript", { tabId: tab, code: "while (true) {}" })).toEqual({
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
  expect(await runBrowserTool("see_diag", {tabId: 901})).toMatchObject({ok: true, dialog: {status: "unknown"}});
  expect(scriptCalls).toBe(0);
  expect(await runBrowserTool("see_page", {tabId: 901})).toMatchObject({ok: false, faultCode: "dialog_open", dialog: {type: "prompt", message: "Name?"}});
  expect(await runBrowserTool("see_diag", {tabId: 901})).toMatchObject({dialog: {status: "open"}});
  expect(await runBrowserTool("handle_dialog", {tabId: 901, action: "accept", promptText: "Ada"})).toMatchObject({ok: true, dialog: {status: "closed"}});
  expect(commands).toContainEqual(["Page.handleJavaScriptDialog", {accept: true, promptText: "Ada"}]);
  expect(scriptCalls).toBe(1);
  detach({tabId: 901});
  expect(await runBrowserTool("see_diag", {tabId: 901})).toMatchObject({dialog: {status: "unknown"}});
});

test("detach_debugger detaches debugger target and ignores already detached errors", async () => {
  let detachedTab: any = null;
  globals.chrome = {
    tabs: { get: async () => ({ id: 905, url: "https://example.com" }) },
    debugger: {
      detach: async (target: any) => { detachedTab = target.tabId; },
    },
  };
  expect(await runBrowserTool("detach_debugger", { tabId: 905 })).toEqual({ ok: true, tabId: 905, detached: true });
  expect(detachedTab).toBe(905);

  // When already detached, it should succeed without throwing
  globals.chrome.debugger.detach = async () => { throw new Error("Debugger is not attached"); };
  expect(await runBrowserTool("detach_debugger", { tabId: 905 })).toEqual({ ok: true, tabId: 905, detached: true });
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
  expect(await runBrowserTool("handle_dialog", {tabId: 902, action: "dismiss"})).toMatchObject({ok: true});
  fail = true;
  expect(await runBrowserTool("handle_dialog", {tabId: 902, action: "dismiss"})).toMatchObject({ok: false, faultCode: "no_dialog"});
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
  expect(await runBrowserTool("capture_page", {mode: "full_page",tabId: 903})).toMatchObject({ok: true, fullPage: true, page_size: [800, 6000]});
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
  expect(await runBrowserTool('websocket_monitor', {tabId: tab, action: 'start'})).toMatchObject({ok: true, started: true});
  expect(await runBrowserTool('websocket_monitor', {tabId: tab, action: 'start'})).toMatchObject({already: true});
  expect(commands.filter(c => c === 'Network.enable')).toHaveLength(1);
  const frame = (id: number, dir: string, data: string) => onEvent.emit({tabId: id}, `Network.webSocketFrame${dir}`, {requestId: 'socket', response: {opcode: 1, payloadData: data}});
  frame(tab + 1, 'Received', 'unrelated');
  frame(tab, 'Sent', 'outbound'); frame(tab, 'Received', 'inbound');
  const read = await runBrowserTool('websocket_monitor', {tabId: tab, action: 'read'});
  expect(read.messages.map((m: any) => [m.dir, m.data])).toEqual([['out', 'outbound'], ['in', 'inbound']]);
  for (let i = 0; i < 55; i++) frame(tab, 'Received', String(i));
  frame(tab, 'Received', 'x'.repeat(17000));
  const stopped = await runBrowserTool('websocket_monitor', {tabId: tab, action: 'stop'});
  expect(stopped.messages).toHaveLength(50);
  expect(stopped.messages.at(-1)).toMatchObject({truncated: true, opcode: 1});
  expect(stopped.messages.at(-1).data).toHaveLength(16000);
  expect(onEvent.listeners.size).toBe(1); // shared dialog listener remains
  frame(tab, 'Received', 'after-stop');
  expect(await runBrowserTool('websocket_monitor', {tabId: tab, action: 'read'})).toMatchObject({monitoring: false, messages: []});
  expect(commands).not.toContain('Network.disable');
  await runBrowserTool('websocket_monitor', {tabId: tab, action: 'start'});
  expect(await runBrowserTool('websocket_monitor', {tabId: tab, action: 'read'})).toMatchObject({monitoring: true, messages: []});
  await runBrowserTool('websocket_monitor', {tabId: tab, action: 'stop'});
});

test('explicit debugger detach preserves failed connections and cleans monitors without an onDetach event', async () => {
  const tab = 3110;
  const {onEvent, commands} = mockSocketBrowser(tab);
  let attaches = 0;
  globals.chrome.debugger.attach = async () => { attaches++; };
  await runBrowserTool('websocket_monitor', {tabId: tab, action: 'start'});
  globals.chrome.debugger.detach = async () => { throw new Error('Permission denied'); };
  await expect(runBrowserTool('detach_debugger', {tabId: tab})).rejects.toThrow('Permission denied');
  expect(await runBrowserTool('websocket_monitor', {tabId: tab, action: 'read'})).toMatchObject({monitoring: true});
  expect(attaches).toBe(1);
  expect(commands.filter(c => c === 'Page.enable')).toHaveLength(1);
  // Chrome's explicit detach does not emit onDetach.
  globals.chrome.debugger.detach = async () => {};
  expect(await runBrowserTool('detach_debugger', {tabId: tab})).toMatchObject({detached: true});
  expect(onEvent.listeners.size).toBe(1);
  expect(await runBrowserTool('websocket_monitor', {tabId: tab, action: 'read'})).toMatchObject({monitoring: false, messages: []});
  expect(await runBrowserTool('websocket_monitor', {tabId: tab, action: 'start'})).toMatchObject({started: true});
  expect(attaches).toBe(2);
  expect(commands.filter(c => c === 'Network.enable')).toHaveLength(2);
  await runBrowserTool('detach_debugger', {tabId: tab});
});

for (const reason of ['detach', 'close', 'failure']) test(`WebSocket monitor releases listeners after ${reason}`, async () => {
  const tab = reason === 'detach' ? 3102 : reason === 'close' ? 3103 : 3104;
  const {onEvent, onDetach, onRemoved} = mockSocketBrowser(tab, reason === 'failure');
  const result = await runBrowserTool('websocket_monitor', {tabId: tab, action: 'start'});
  if (reason === 'failure') expect(result.ok).toBe(false);
  else {
    expect(result.ok).toBe(true);
    if (reason === 'detach') onDetach.emit({tabId: tab});
    else onRemoved.emit(tab);
  }
  expect(onEvent.listeners.size).toBe(1);
  expect(onDetach.listeners.size).toBe(1);
  expect(onRemoved.listeners.size).toBe(1);
  expect(await runBrowserTool('websocket_monitor', {tabId: tab, action: 'read'})).toMatchObject({monitoring: false, messages: []});
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
    expect(await runBrowserTool('service_worker_list', {tabId: 3201})).toMatchObject({ok: true, serviceWorkers: [{scope: registration.scope, active: registration.active.scriptURL}]});
    expect(scripts.every(id => id === 3201)).toBe(true);
    Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {}});
    expect(await runBrowserTool('service_worker_list', {tabId: 3201})).toMatchObject({ok: false, error: '该页面不支持 Service Worker API'});
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
    const observed = await runBrowserTool('page.list_interactive_elements', {tabId: 1});
    expect(observed.elements.map((el: any) => el.id)).toEqual(['e_01', 'e_02']);
    nodes.reverse();
    expect((await runBrowserTool('page.click', {tabId: 1, id: 'e_01'})).ok).toBe(true);
    expect(first.clicks).toBe(1);
    expect(second.clicks).toBe(0);
    first.isConnected = false;
    nodes = [new Node('replacement'), second];
    expect((await runBrowserTool('page.click', {tabId: 1, id: 'e_01'})).ok).toBe(false);
    const replacement = await runBrowserTool('page.list_interactive_elements', {tabId: 1});
    expect(replacement.elements.map((el: any) => el.id)).toEqual(['e_03', 'e_02']);
    expect(replacement.elements[0].regionId).toBe('r_01');
  } finally {
    keys.forEach((key, index) => {
      if (originals[index]) Object.defineProperty(globals, key, originals[index]!);
      else delete globals[key];
    });
  }
});


test("open tabs snapshot keeps per-window activation and focus without choosing a target", async () => {
  const windows = [
    {id: 11, focused: true, tabs: [{id: 101, active: true, url: 'https://one', title: 'One'}]},
    {id: 22, focused: false, tabs: [{id: 202, active: true, url: 'https://two', title: 'Two'}]},
  ];
  globals.chrome = {windows: {getAll: async (options: any) => {
    expect(options).toEqual({populate: true, windowTypes: ['normal']}); return windows;
  }}};
  const expected = {ok: true, windows: windows.map(w => ({windowId: w.id, focused: w.focused,
    tabs: w.tabs.map(t => ({tabId: t.id, active: t.active, url: t.url, title: t.title}))}))};
  expect(await readOpenTabs()).toEqual(expected);
  expect(await runBrowserTool('see_env')).toEqual(expected);
  expect(await runBrowserTool('list_tabs')).toEqual(expected);
});

test("tab actions never fall back to the foreground and opening preserves focus", async () => {
  const created: any[] = [];
  globals.chrome = {
    tabs: {get: async () => {throw Error('No tab');},
      query: async () => {throw Error('must not query foreground');},
      create: async (options: any) => {created.push(options); return {id: 20, ...options};}},
    windows: {create: async (options: any) => {created.push(options); return {id: 3};}},
  };
  await expect(runBrowserTool('close_tab', {})).rejects.toThrow('tabId');
  await expect(runBrowserTool('close_tab', {tabId: 404})).rejects.toThrow('404');
  await expect(runBrowserTool('open_tab', {url: 'https://example.com'})).rejects.toThrow('windowId');
  expect(await runBrowserTool('open_tab', {windowId: 2, url: 'https://example.com'})).toMatchObject({ok: true, tabId: 20});
  expect(await runBrowserTool('create_window', {url: 'https://example.com'})).toMatchObject({ok: true, windowId: 3});
  expect(created).toEqual([{windowId: 2, url: 'https://example.com', active: false}, {url: 'https://example.com', focused: false}]);
});

test("viewport capture targets the requested tab through CDP without activating it or retrying", async () => {
  globals.createImageBitmap = async () => ({width: 800, height: 600, close() {}});
  const commands: any[] = [];
  globals.chrome = {
    tabs: {get: async () => ({id: 9012, windowId: 11, url: 'https://example.com'})},
    scripting: {executeScript: async () => [{result: [800, 600]}]},
    debugger: {attach: async () => {}, sendCommand: async (...args: any[]) => {commands.push(args); return {data: 'AA=='};}},
  };
  expect(await runBrowserTool('capture_page', {tabId: 9012, mode: 'viewport'})).toMatchObject({ok: true, tabId: 9012, image: 'data:image/jpeg;base64,AA==', viewport: [800, 600]});
  expect(commands).toEqual([[{tabId: 9012}, 'Page.captureScreenshot', {format: 'jpeg', quality: 70, fromSurface: true, captureBeyondViewport: false}]]);
  globals.chrome.debugger.sendCommand = async () => {throw Error('Capture unavailable');};
  expect(await runBrowserTool('capture_page', {tabId: 9012, mode: 'viewport'})).toMatchObject({ok: false, error: 'Capture unavailable'});
});

test("capture_page som annotates interactives, returns marks, and clears overlay", async () => {
  const scriptCalls: any[] = [];
  globals.chrome = {
    tabs: {get: async () => ({id: 9100, windowId: 1, url: 'https://example.com'})},
    scripting: {
      executeScript: async (options: any) => {
        scriptCalls.push(options);
        const fnName = options.func?.name || '';
        if (fnName === 'somClear') {
          return [{result: {ok: true}}];
        }
        return [{result: {
          ok: true,
          pixelRatio: 2,
          viewport: [800, 600],
          total: 2,
          marks: [
            {badge: 1, id: 'e_01', x: 10, y: 20, w: 80, h: 24, role: 'button', name: '提交', tag: 'button'},
            {badge: 2, id: 'e_02', x: 10, y: 60, w: 120, h: 28, role: 'link', name: '更多', tag: 'a'},
          ],
        }}];
      },
    },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async () => ({data: 'AA=='}),
    },
  };
  const result = await runBrowserTool('capture_page', {tabId: 9100, mode: 'som', maxMarks: 20, roles: ['button', 'link']});
  expect(result).toMatchObject({
    ok: true,
    mode: 'som',
    image: 'data:image/jpeg;base64,AA==',
    devicePixelRatio: 2,
    viewport: [800, 600],
  });
  expect(result.marks?.map((m: any) => m.id)).toEqual(['e_01', 'e_02']);
  expect(scriptCalls.length).toBeGreaterThanOrEqual(2);
});

test("wait A11y states probe uses role/name/states via page.wait_a11y", async () => {
  const seen: any[] = [];
  globals.chrome = {
    tabs: {get: async () => ({id: 9200, windowId: 1, url: 'https://example.com'})},
    scripting: {
      executeScript: async (options: any) => {
        const name = String(options.func || '');
        const args = options.args?.[1] || options.args?.[0];
        if (Array.isArray(options.args) && options.args[0] === 'page.wait_a11y') {
          seen.push(options.args[1]);
          return [{result: {ok: true, id: 'e_05', role: 'button', name: '下一步', states: {enabled: true}, total: 1, matchIndex: 0}}];
        }
        if (name.includes('innerHeight') || String(options.func).includes('innerWidth')) {
          return [{result: [800, 600]}];
        }
        // inspectTab title/url/text
        return [{result: {ok: true, title: 'T', url: 'https://example.com', text: ''}}];
      },
    },
  };
  const result = await runBrowserTool('wait', {
    tabId: 9200,
    reason: '等按钮可用',
    affectsPage: false,
    role: 'button',
    name: '下一步',
    states: {enabled: true},
    ms: 1000,
  });
  expect(result).toMatchObject({ok: true, id: 'e_05', role: 'button'});
  expect(seen[0]).toMatchObject({role: 'button', name: '下一步', states: {enabled: true}});
});
