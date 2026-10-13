import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { waitForResponse, summarizeResponseBody, startPageFeedback, finishPageFeedback } from './response-wait.js';
import { runBrowserTool } from './browser-tools.js';
import { resetActionObserverForTests, endActionObserve } from './action-observer.js';

const g = globalThis as any;
const original = { chrome: g.chrome, document: g.document, MutationObserver: g.MutationObserver };
let tab = 4800;
let window: Window | undefined;
afterEach(() => {
  Object.assign(g, original);
  window?.happyDOM.abort();
  window = undefined;
  resetActionObserverForTests();
});
function bus() {
  const listeners = new Set<(...args: any[]) => void>();
  return { listeners, addListener: (f: any) => listeners.add(f), removeListener: (f: any) => listeners.delete(f),
    emit: (...args: any[]) => { for (const f of [...listeners]) f(...args); } };
}
function browser(body = '{"code":120006,"message":"USERNAME_EXISTS","token":"private"}') {
  const id = ++tab, onEvent = bus(), onDetach = bus(), commands: string[] = [];
  g.chrome = {
    tabs: { get: async () => ({ id, url: 'https://example.com/register', status: 'complete' }), onRemoved: bus(), onUpdated: bus() },
    debugger: { onEvent, onDetach, attach: async () => {}, sendCommand: async (_: any, command: string) => {
      commands.push(command);
      return command === 'Network.getResponseBody' ? { body } : {};
    } },
  };
  const emit = (method: string, params: any) => onEvent.emit({ tabId: id }, method, params);
  const response = (requestId = 'new', url = 'https://example.com/api/register?token=secret#fragment', type = 'XHR') => {
    emit('Network.responseReceived', { requestId, type, response: { url, status: 200, mimeType: 'application/json' } });
  };
  const request = (requestId = 'new', method = 'POST') => emit('Network.requestWillBeSent', { requestId, request: { method } });
  const finish = (requestId = 'new') => emit('Network.loadingFinished', { requestId });
  return { id, onEvent, onDetach, commands, emit, response, request, finish };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('JSON response keeps business errors, redacts nested secrets and bounds output', () => {
  const out = summarizeResponseBody({ body: JSON.stringify({ code: 120006, message: 'USERNAME_EXISTS', password: 'p',
    nested: [{ api_key: 'key', text: 'Bearer abc eyJhbGci.x.y' }] }) });
  expect(out).toMatchObject({ redacted: true, body: { code: 120006, message: 'USERNAME_EXISTS', password: '[REDACTED]',
    nested: [{ api_key: '[REDACTED]', text: '[REDACTED] [REDACTED]' }] } });
  expect(summarizeResponseBody({ body: btoa('{"message":"ok"}'), base64Encoded: true })).toMatchObject({ body: { message: 'ok' } });
  expect(summarizeResponseBody({ body: '<html>password</html>' })).toEqual({ bodyUnavailable: 'non_json_body_omitted' });
  expect(summarizeResponseBody({ body: '' })).toEqual({ bodyUnavailable: 'empty_body' });
  const large = summarizeResponseBody({ body: JSON.stringify({ token: 'private', text: 'x'.repeat(9000) }) });
  expect(large.bodyTruncated).toBe(true);
  expect(large.bodyPreview?.length).toBe(8000);
  expect(large.bodyPreview).not.toContain('private');
});

test('listener initialized before click, fast HTTP200 business failure and effects survive', async () => {
  const b = browser();
  const out = await waitForResponse(b.id, { urlContains: '/api/register' }, async () => {
    expect(b.commands).toEqual(['Network.enable', 'Page.enable']);
    expect(b.onEvent.listeners.size).toBeGreaterThan(0);
    b.request(); b.response(); b.finish();
    await flush();
    return { ok: true, clicked: true, effects: { delta: { invalid: true } } };
  });
  expect(out).toMatchObject({ ok: true, clicked: true, status: 200, body: { code: 120006, message: 'USERNAME_EXISTS', token: '[REDACTED]' },
    click: { effects: { delta: { invalid: true } } } });
  expect(out.url).not.toContain('secret');
  expect(out.url).not.toContain('fragment');
  expect(b.commands.filter(x => x === 'Network.getResponseBody')).toHaveLength(1);
  // Only permanent dialog listeners remain; the waiter removes its own listeners.
  expect(b.onEvent.listeners.size).toBe(1);
  expect(b.onDetach.listeners.size).toBe(1);
});

test('click waits exclude old in-flight responses, other tabs, status mismatch and preflight', async () => {
  const b = browser();
  const out = await waitForResponse(b.id, { urlContains: '/api/register', status: 200 }, async () => {
    b.response('old'); b.finish('old');
    b.request('preflight', 'OPTIONS'); b.response('preflight'); b.finish('preflight');
    b.onEvent.emit({ tabId: b.id + 1 }, 'Network.responseReceived', { requestId: 'wrongtab', response: { url: '/api/register', status: 200 } });
    b.request('bad'); b.emit('Network.responseReceived', { requestId: 'bad', response: { url: '/api/register', status: 500 } });
    b.request('correct'); b.response('correct');
    expect(b.commands).not.toContain('Network.getResponseBody');
    b.finish('correct');
    return { ok: true };
  });
  expect(out.requestId).toBe('correct');
  expect(b.commands.filter(x => x === 'Network.getResponseBody')).toHaveLength(1);
});

test('plain response wait remains metadata-only; body retrieval failures explicit', async () => {
  const b = browser();
  const pending = runBrowserTool('wait_response', { tabId: b.id, urlContains: '/api' });
  await new Promise(resolve => setTimeout(resolve, 0)); b.response();
  const out = await pending;
  expect(out).toMatchObject({ ok: true, status: 200 });
  expect(out.body).toBeUndefined();
  expect(b.commands).not.toContain('Network.getResponseBody');
  const c = browser();
  g.chrome.debugger.sendCommand = async (_: any, method: string) => { if (method === 'Network.getResponseBody') throw new Error('sensitive details'); };
  const out2 = await waitForResponse(c.id, { urlContains: '/api' }, async () => {
    c.request(); c.response(); c.finish(); return { ok: true };
  });
  expect(out2).toMatchObject({ ok: true, bodyUnavailable: 'get_response_body_failed' });
  expect(JSON.stringify(out2)).not.toContain('sensitive details');
});

test('click failure wins over synchronous matched response; loading failure and detach retain cause', async () => {
  const b = browser();
  const out = await waitForResponse(b.id, { urlContains: '/api' }, async () => {
    b.request(); b.response(); b.finish(); await flush(); return { ok: false, error: 'target missing' };
  });
  expect(out).toMatchObject({ ok: false, clicked: false, failureStage: 'click', error: 'target missing' });
  const c = browser();
  const failed = await waitForResponse(c.id, { urlContains: '/api' }, async () => {
    c.request(); c.response(); c.emit('Network.loadingFailed', { requestId: 'new', errorText: 'failed' }); return { ok: true };
  });
  expect(failed).toMatchObject({ ok: false, failureStage: 'loading_failed' });
  const d = browser();
  const detached = await waitForResponse(d.id, { urlContains: '/api' }, async () => {
    d.onDetach.emit({ tabId: d.id }, 'target_closed'); return { ok: true };
  });
  expect(detached).toMatchObject({ ok: false, failureStage: 'detached', detachReason: 'target_closed' });
});

test('deadline covers stuck initialization, stuck click and unfinished body without retry', async () => {
  for (const stage of ['initialize', 'click', 'response_body']) {
    const b = browser(); let clicks = 0;
    if (stage === 'initialize') g.chrome.debugger.sendCommand = () => new Promise(() => {});
    const before = Date.now();
    const out = await waitForResponse(b.id, { urlContains: '/api', timeoutMs: 500 }, () => {
      clicks++;
      if (stage === 'click') return new Promise(() => {});
      b.request(); b.response(); return Promise.resolve({ ok: true });
    });
    expect(out).toMatchObject({ ok: false, timeout: true, failureStage: stage });
    expect(Date.now() - before).toBeLessThan(1500);
    expect(clicks).toBe(stage === 'initialize' ? 0 : 1);
    if (stage === 'click') expect(out).toMatchObject({ clickPending: true, actionOutcome: 'unknown_do_not_retry' });
    expect(b.onEvent.listeners.size).toBe(1);
  }
});

test('native dialog returns without attempting blocked page sampling', async () => {
  const b = browser();
  const out = await waitForResponse(b.id, { urlContains: '/api' }, () => {
    b.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'Please retry' });
    return new Promise(() => {});
  });
  expect(out).toMatchObject({ ok: false, failureStage: 'dialog', dialogOpen: true, dialogs: [{ type: 'alert', message: 'Please retry' }] });
  g.chrome.scripting = { executeScript: () => { throw new Error('must not sample'); } };
  expect(await endActionObserve({ tabId: b.id, mark: 0 }, out)).toEqual(out);
});

test('page probe catches removed transient alert, excludes baseline, bounds messages and cleans up', async () => {
  browser(); window = new Window();
  g.document = window.document; g.MutationObserver = window.MutationObserver;
  const doc = window.document;
  doc.body.innerHTML = '<div role="alert">old</div><input name="email" type="email" value="bad">';
  const targets: any[] = [];
  g.chrome.scripting = { executeScript: async ({ target, func, args }: any) => {
    targets.push(target); return [{ result: await func(...args) }];
  } };
  const session = await startPageFeedback(tab, 7);
  const alert = doc.createElement('div'); alert.setAttribute('role', 'alert'); alert.textContent = 'USERNAME_EXISTS';
  doc.body.append(alert); alert.remove();
  await new Promise(resolve => setTimeout(resolve, 10));
  for (let i = 0; i < 12; i++) {
    const toast = doc.createElement('div'); toast.className = 'toast'; toast.textContent = i + 'x'.repeat(500); doc.body.append(toast);
  }
  await new Promise(resolve => setTimeout(resolve, 10));
  const out = await finishPageFeedback(tab, session, 7);
  expect(out.alerts).toContain('USERNAME_EXISTS');
  expect(out.alerts).not.toContain('old');
  expect(out.alerts.length).toBeLessThanOrEqual(8);
  expect(out.alerts.every((s: string) => s.length <= 300)).toBe(true);
  expect(out.invalidFields).toMatchObject([{ name: 'email' }]);
  expect(targets).toEqual([{ tabId: tab, frameIds: [7] }, { tabId: tab, frameIds: [7] }]);
  expect(session.key && g[session.key]).toBeUndefined();
  expect(await finishPageFeedback(tab, session, 7)).toEqual({ unavailable: 'document_changed_or_probe_missing' });
});

test('real browser dispatch forwards frameId and retains response, feedback and navigation', async () => {
  resetActionObserverForTests();
  const b = browser(); let clicked = 0; const targets: any[] = [];
  g.chrome.scripting = { executeScript: async ({ target, args }: any) => {
    if (args?.[0] === 'start') return [{ result: { started: true } }];
    if (args?.[0] === 'finish') return [{ result: { alerts: ['USERNAME_EXISTS'], invalidFields: [] } }];
    if (args?.[0] === 'page_click') {
      targets.push(target); clicked++;
      expect(b.commands).toContain('Page.enable');
      b.request(); b.response(); b.finish();
      g.chrome.tabs.get = async () => ({ id: b.id, url: 'https://example.com/profile', status: 'complete' });
      return [{ result: { ok: true, clicked: true } }];
    }
    return [{ result: { ok: true, title: 'Example', url: 'https://example.com/register', text: '', alerts: [], html: '' } }];
  } };
  const out = await runBrowserTool('wait_response', { tabId: b.id, clickId: 'e_01', frameId: 7, urlContains: '/api' });
  expect(out).toMatchObject({ ok: true, clicked: true, body: { code: 120006, message: 'USERNAME_EXISTS' },
    pageFeedback: { alerts: ['USERNAME_EXISTS'] }, effects: { nav: { urlChanged: true, to: 'https://example.com/profile' } } });
  expect(clicked).toBe(1);
  expect(targets).toEqual([{ tabId: b.id, frameIds: [7] }]);
});
