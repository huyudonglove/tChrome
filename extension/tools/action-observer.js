// Causal action observer: ring buffer of Network/Console errors + sparse effects merge.
// Only wired for side-effectful actions; read-only tools skip this path.

const MAX_EVENTS = 50;
const TRUNC = 150;
const MAX_ALERTS = 8;

/** Whitelist only — never full-page DOM diff (phase 3). */
const ALERT_SELECTORS =
  '[role="alert"], [aria-live], .el-message, .ant-message, .toast, .alert-danger, .error-tip';

/** tabId → { seq, events, net, runtime } */
const buffers = new Map();
let listenerReady = false;

const clip = (value, n = TRUNC) => String(value ?? "").slice(0, n);

/** Sample alert/toast texts; best-effort, never throws. */
async function sampleAlerts(tabId) {
  try {
    if (!globalThis.chrome?.scripting?.executeScript) return [];
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (selector) => {
        const nodes = document.querySelectorAll(selector);
        const texts = [];
        for (const node of nodes) {
          const text = String(node.innerText || node.textContent || "").trim().replace(/\s+/g, " ");
          if (text) texts.push(text.slice(0, 150));
          if (texts.length >= 8) break;
        }
        return texts;
      },
      args: [ALERT_SELECTORS],
    });
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

const MAX_HTML_SNAPSHOT = 200_000;

/**
 * Structural HTML snapshot with CSS noise stripped (style/link/script/class/inline style/comments).
 * Runs in the page; transfer is cleaned HTML only. null = unavailable.
 */
async function sampleCleanHtml(tabId) {
  try {
    if (!globalThis.chrome?.scripting?.executeScript) return null;
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (cap) => {
        const clone = document.documentElement.cloneNode(true);
        clone.querySelectorAll("style, link[rel=\"stylesheet\"], script").forEach((n) => n.remove());
        for (const el of clone.querySelectorAll("*")) {
          el.removeAttribute("style");
          el.removeAttribute("class");
        }
        const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
        const comments = [];
        while (walker.nextNode()) comments.push(walker.currentNode);
        for (const c of comments) c.parentNode?.removeChild(c);
        const html = clone.outerHTML.replace(/\s+/g, " ").trim();
        return html.length > cap ? html.slice(0, cap) : html;
      },
      args: [MAX_HTML_SNAPSHOT],
    });
    return typeof result === "string" && result ? result : null;
  } catch {
    return null;
  }
}

/** Code-side diff on cleaned HTML. Returns compact "-old +new" string or null if unchanged. */
export function summarizeDomDiff(before, after) {
  if (before == null || after == null || before === after) return null;
  let start = 0;
  const min = Math.min(before.length, after.length);
  while (start < min && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start
    && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const removed = before.slice(start, endBefore);
  const added = after.slice(start, endAfter);
  const parts = [];
  if (removed) parts.push(`-${clip(removed, 120)}`);
  if (added) parts.push(`+${clip(added, 120)}`);
  if (!parts.length) return null;
  return parts.join(" ");
}

export function initActionObserver() {
  if (listenerReady || !globalThis.chrome?.debugger?.onEvent) return;
  listenerReady = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (tabId == null) return;
    const buf = buffers.get(tabId);
    if (!buf) return;
    let event = null;
    if (method === "Network.responseReceived") {
      const status = Number(params?.response?.status || 0);
      if (status >= 400) {
        event = {
          kind: "network",
          status,
          url: clip(params?.response?.url || params?.response?.url || "", 160),
          method: params?.type || undefined,
          requestId: params?.requestId,
        };
      }
    } else if (method === "Network.loadingFailed") {
      event = {
        kind: "network",
        error: clip(params?.errorText || "loadingFailed"),
        url: clip(params?.blockedReason || "", 0) || undefined,
        requestId: params?.requestId,
      };
    } else if (method === "Runtime.exceptionThrown") {
      const details = params?.exceptionDetails;
      const desc = details?.exception?.description || details?.text || "exception";
      event = { kind: "console", level: "error", text: clip(desc) };
    } else if (method === "Runtime.consoleAPICalled" && params?.type === "error") {
      const args = Array.isArray(params?.args) ? params.args : [];
      const text = args.map((a) => a?.value ?? a?.description ?? a?.type ?? "").join(" ");
      event = { kind: "console", level: "error", text: clip(text) };
    }
    if (!event) return;
    buf.seq += 1;
    buf.events.push({ seq: buf.seq, ...event });
    if (buf.events.length > MAX_EVENTS) buf.events.shift();
  });
  chrome.debugger.onDetach.addListener(({ tabId }) => {
    if (tabId != null) buffers.delete(tabId);
  });
}

async function ensureDomains(tabId) {
  initActionObserver();
  let buf = buffers.get(tabId);
  if (!buf) {
    buf = { seq: 0, events: [], net: false, runtime: false };
    buffers.set(tabId, buf);
  }
  // Attach + enable once per tab buffer lifetime.
  const { withDebugger } = await import("./dialogs.js");
  await withDebugger(tabId, async () => {
    if (!buf.net) {
      await chrome.debugger.sendCommand({ tabId }, "Network.enable", {});
      buf.net = true;
    }
    if (!buf.runtime) {
      await chrome.debugger.sendCommand({ tabId }, "Runtime.enable", {});
      buf.runtime = true;
    }
  });
  return buf;
}

/** Best-effort response body for failed requests; never throws. */
async function fetchBody(tabId, requestId) {
  if (!requestId) return undefined;
  try {
    const { withDebugger } = await import("./dialogs.js");
    const res = await withDebugger(tabId, () =>
      chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId }));
    const body = typeof res?.body === "string" ? res.body : "";
    if (!body) return undefined;
    return clip(body);
  } catch {
    return undefined;
  }
}

export async function beginActionObserve(tabId) {
  try {
    const buf = await ensureDomains(tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const alertsBefore = await sampleAlerts(tabId);
    const htmlBefore = await sampleCleanHtml(tabId);
    return {
      tabId,
      mark: buf.seq,
      urlBefore: typeof tab?.url === "string" ? tab.url : null,
      alertsBefore,
      htmlBefore,
    };
  } catch {
    // Observer is best-effort; never block the action when CDP domains cannot attach.
    return { tabId, mark: -1, urlBefore: null, disabled: true, alertsBefore: [], htmlBefore: null };
  }
}

export async function endActionObserve(session, result, extras = {}) {
  if (!session || session.disabled || !result || typeof result !== "object") return result;
  const buf = buffers.get(session.tabId);
  const fresh = buf ? buf.events.filter((e) => e.seq > session.mark) : [];

  const network = [];
  const consoleErrors = [];
  for (const e of fresh) {
    if (e.kind === "network") {
      const row = {
        ...(e.status !== undefined ? { status: e.status } : {}),
        ...(e.error ? { error: e.error } : {}),
        ...(e.url ? { url: e.url } : {}),
        ...(e.method ? { method: e.method } : {}),
      };
      if (e.requestId && row.status >= 400) {
        const body = await fetchBody(session.tabId, e.requestId);
        if (body) row.body = body;
      }
      network.push(row);
    } else if (e.kind === "console") {
      consoleErrors.push({ level: e.level, text: e.text });
    }
  }

  let urlAfter = null;
  try {
    const tab = await chrome.tabs.get(session.tabId);
    urlAfter = typeof tab?.url === "string" ? tab.url : null;
  } catch {
    urlAfter = null;
  }
  const urlChanged = Boolean(session.urlBefore && urlAfter && session.urlBefore !== urlAfter);

  // Phase 3: whitelist alert diff — only texts that appeared after the action.
  const alertsAfter = await sampleAlerts(session.tabId);
  const beforeSet = new Set(session.alertsBefore || []);
  const newAlerts = alertsAfter.filter((text) => !beforeSet.has(text)).slice(0, MAX_ALERTS);

  // Phase 3: cleaned-HTML structural diff in code; model only sees compact summary.
  const htmlAfter = await sampleCleanHtml(session.tabId);
  const domChange = summarizeDomDiff(session.htmlBefore, htmlAfter);

  const delta = { ...extras };
  if (result.delta && typeof result.delta === "object") {
    Object.assign(delta, result.delta);
    delete result.delta;
  }

  const effects = {};
  if (network.length) effects.network = network;
  if (consoleErrors.length) effects.console = consoleErrors;
  if (urlChanged) effects.nav = { urlChanged: true, to: urlAfter };
  if (Object.keys(delta).length) effects.delta = delta;
  if (newAlerts.length) effects.mutations = { newAlerts };
  if (domChange) effects.domChange = domChange;

  if (!Object.keys(effects).length) return result;
  // Sparse: only merge when something is new; never emit empty arrays.
  return { ...result, effects: { ...(result.effects && typeof result.effects === "object" ? result.effects : {}), ...effects } };
}

/** Run a side-effectful action under observe → existing waits → sparse delta merge. */
export async function observeAction(tabId, run, extrasFactory) {
  const session = await beginActionObserve(tabId);
  let result;
  try {
    result = await run();
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const extras = typeof extrasFactory === "function" ? (await extrasFactory(result)) || {} : {};
  return endActionObserve(session, result, extras);
}

export function resetActionObserverForTests() {
  buffers.clear();
  listenerReady = false;
}
