import { withDebugger } from './dialogs.js';

const SECRET_KEY = /password|passwd|secret|token|authorization|cookie|credential|api[-_]?key/i;
const MAX_BODY = 8000;

function redactUrl(value) {
  try {
    const url = new URL(value);
    if (url.username) url.username = '[REDACTED]';
    if (url.password) url.password = '[REDACTED]';
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEY.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    if (url.hash) url.hash = '';
    return url.href;
  } catch { return String(value).replace(/([?&](?:[^=&]*(?:token|password|secret|credential|api[_-]?key)[^=&]*)=)[^&#]*/gi, '$1[REDACTED]'); }
}

/** Only structured JSON is exposed; arbitrary HTML/text may contain credentials. */
export function summarizeResponseBody(response) {
  let text = String(response?.body ?? '');
  if (response?.base64Encoded) {
    try {
      text = new TextDecoder().decode(Uint8Array.from(atob(text), c => c.charCodeAt(0)));
    } catch { return { bodyUnavailable: 'base64_decode_failed' }; }
  }
  let value;
  try { value = JSON.parse(text); }
  catch { return { bodyUnavailable: text ? 'non_json_body_omitted' : 'empty_body' }; }
  let redacted = false;
  const clean = (v, depth = 0) => {
    if (depth > 30) return '[depth limit]';
    if (Array.isArray(v)) return v.map(x => clean(x, depth + 1));
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([key, val]) => {
        if (SECRET_KEY.test(key)) { redacted = true; return [key, '[REDACTED]']; }
        return [key, clean(val, depth + 1)];
      }));
    }
    if (typeof v === 'string') {
      return v.replace(/\bBearer\s+[^\s"<>]+|\beyJ[\w-]+\.[\w-]+\.[\w-]+/gi, () => {
        redacted = true; return '[REDACTED]';
      });
    }
    return v;
  };
  const body = clean(value);
  const encoded = JSON.stringify(body);
  return encoded.length > MAX_BODY
    ? { bodyPreview: encoded.slice(0, MAX_BODY), bodyTruncated: true, bodyChars: encoded.length, redacted }
    : { body, redacted };
}

/** One extension invocation: arm → initialize → optional click → response + loadingFinished.
 * Matching requests are candidates, not proof of causal or business success.
 */
export async function waitForResponse(tabId, input, click) {
  const urlPart = String(input.urlContains || input.url || '').trim();
  if (!urlPart) return { ok: false, tabId, error: 'wait_response 需要 urlContains' };
  const wantStatus = input.status === undefined || input.status === null || input.status === '' ? null : Number(input.status);
  const timeoutMs = Math.min(Math.max(Number(input.timeoutMs ?? input.ms) || 8000, 500), 12000);
  const includeBody = input.includeBody === true || Boolean(click);
  const events = chrome.debugger.onEvent;
  const detached = chrome.debugger.onDetach;
  let matched, clicked, candidate, timer;
  let finished = false, active = false, reading = false, clickStarted = false;
  let stage = 'initialize';
  const completed = new Set();
  const started = new Set();
  const preflight = new Set();
  const dialogs = [];
  let resolve;
  const result = new Promise(done => { resolve = done; });
  const cleanup = () => {
    clearTimeout(timer);
    events.removeListener(onEvent);
    detached.removeListener(onDetach);
  };
  const settle = (value, force = false) => {
    if (finished) return;
    // Keep a fast response until the click result is known. Deadline still wins.
    if (click && clickStarted && clicked === undefined && !force) { candidate = value; return; }
    finished = true;
    cleanup();
    resolve({ ...value, ...(dialogs.length ? { dialogs } : {}), ...(click ? {
      clicked: clicked?.ok === true, click: clicked ?? null,
      ...(clickStarted && clicked === undefined ? { clickPending: true, actionOutcome: 'unknown_do_not_retry' } : {}),
    } : {}) });
  };
  const fail = (failureStage, error, extra = {}) => settle({
    ok: false, tabId, urlContains: redactUrl(urlPart), faultCode: 'tool_execution_failed', failureStage, error, ...extra,
  }, true);
  const readBody = async () => {
    if (reading || finished || !matched) return;
    reading = true;
    try {
      const response = await chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId: matched.requestId });
      settle({ ok: true, tabId, urlContains: redactUrl(urlPart), ...matched, ...summarizeResponseBody(response) });
    } catch {
      settle({ ok: true, tabId, urlContains: redactUrl(urlPart), ...matched, bodyUnavailable: 'get_response_body_failed' });
    }
  };
  const onEvent = (source, method, params) => {
    if (source.tabId !== tabId || !active || finished) return;
    if (method === 'Page.javascriptDialogOpening') {
      dialogs.push({ type: params.type, message: String(params.message || '').slice(0, 300) });
      fail('dialog', '原生弹窗阻塞了操作，请先处理弹窗', { dialogOpen: true });
    } else if (method === 'Network.requestWillBeSent') {
      if (started.size < 200) started.add(params.requestId);
      if (params.request?.method === 'OPTIONS' || params.type === 'Preflight') preflight.add(params.requestId);
    } else if (method === 'Network.loadingFinished') {
      completed.add(params.requestId);
      if (completed.size > 200) completed.delete(completed.values().next().value);
      if (matched?.requestId === params.requestId) void readBody();
    } else if (method === 'Network.loadingFailed' && matched?.requestId === params.requestId) {
      fail('loading_failed', '匹配响应加载失败', { response: matched });
    } else if (method === 'Network.responseReceived' && !matched) {
      const url = String(params.response?.url || '');
      const status = Number(params.response?.status || 0);
      if (!url.includes(urlPart) || (wantStatus !== null && status !== wantStatus) || params.type === 'Preflight' || preflight.has(params.requestId)) return;
      // Exclude requests already in flight before this action; concurrent matches remain candidates.
      if (click && !started.has(params.requestId)) return;
      matched = { requestId: params.requestId, url: redactUrl(url), status, mimeType: params.response?.mimeType, time: Date.now() };
      if (!includeBody) settle({ ok: true, tabId, urlContains: redactUrl(urlPart), ...matched });
      else if (completed.has(params.requestId)) void readBody();
    }
  };
  const onDetach = (source, reason) => {
    if (source.tabId === tabId) fail('detached', `浏览器调试连接已断开${reason ? `：${reason}` : ''}`, { detachReason: reason });
  };
  events.addListener(onEvent);
  detached.addListener(onDetach);
  timer = setTimeout(() => settle({
    ok: false, tabId, urlContains: redactUrl(urlPart), timeoutMs, timeout: true,
    failureStage: candidate ? 'click' : matched ? 'response_body' : stage,
    error: '未在时限内完成点击及匹配响应采集，不会自动重试',
    ...(matched ? { response: matched, bodyUnavailable: candidate ? 'click_pending' : 'timeout' } : {}),
  }, true), timeoutMs);
  // Do not await an unbounded debugger initialization or page click before the deadline.
  void (async () => {
    try {
      await withDebugger(tabId, async () => {
        await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
        if (click && !finished) await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
      });
      if (finished) return;
      active = true;
      stage = 'response';
      if (click) {
        clickStarted = true;
        stage = 'click';
        clicked = await click();
        if (finished) return;
        stage = 'response';
        if (!clicked?.ok) settle({ ...clicked, ok: false, tabId, failureStage: 'click' });
        else if (candidate) settle(candidate);
      }
    } catch (error) {
      fail(clickStarted ? 'click' : 'initialize', error instanceof Error ? error.message : String(error));
    }
  })();
  return result;
}

// Lives in the isolated frame world, bounded and removed in finally by the caller.
function pageFeedbackProbe(mode, key) {
  const selector = '[role="alert"], [aria-live], .el-message, .ant-message, .toast, .alert-danger, .error-tip';
  const textOf = node => String(node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 300);
  if (mode === 'start') {
    const before = new Set([...document.querySelectorAll(selector)].map(textOf));
    const alerts = new Set();
    const capture = node => {
      if (node.nodeType !== 1) node = node.parentElement;
      if (!node) return;
      const candidates = [...node.querySelectorAll(selector)];
      if (node.matches(selector)) candidates.unshift(node);
      const parent = node.closest(selector);
      if (parent) candidates.push(parent);
      for (const candidate of candidates) {
        const text = textOf(candidate);
        if (text && !before.has(text) && alerts.size < 8) alerts.add(text);
      }
    };
    const observer = new MutationObserver(records => {
      for (const record of records) {
        capture(record.target);
        for (const node of record.addedNodes) capture(node);
        for (const node of record.removedNodes) capture(node);
      }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['role', 'aria-live', 'class'] });
    globalThis[key] = { observer, alerts, capture };
    return { started: true };
  }
  const state = globalThis[key];
  if (!state) return { unavailable: 'document_changed_or_probe_missing' };
  state.capture(document.documentElement);
  state.observer.disconnect();
  delete globalThis[key];
  const invalidFields = [...document.querySelectorAll('input, select, textarea, [aria-invalid="true"]')]
    .filter(el => el.getAttribute('aria-invalid') === 'true' || el.validity?.valid === false)
    .slice(0, 8).map(el => ({ name: el.getAttribute('aria-label') || el.name || el.id || el.tagName.toLowerCase(), message: String(el.validationMessage || '').slice(0, 300) }));
  return { alerts: [...state.alerts], invalidFields };
}

export async function startPageFeedback(tabId, frameId) {
  const key = `__tchromeFeedback_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  try {
    await chrome.scripting.executeScript({ target: { tabId, ...(frameId == null ? {} : { frameIds: [Number(frameId)] }) }, func: pageFeedbackProbe, args: ['start', key] });
    return { key };
  } catch { return { unavailable: 'page_feedback_start_failed' }; }
}

export async function finishPageFeedback(tabId, session, frameId) {
  if (!session?.key) return session ?? { unavailable: 'page_feedback_not_started' };
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId, ...(frameId == null ? {} : { frameIds: [Number(frameId)] }) }, func: pageFeedbackProbe, args: ['finish', session.key] });
    return result ?? { unavailable: 'page_feedback_empty' };
  } catch { return { unavailable: 'page_feedback_finish_failed' }; }
}
