import { createBrowserIdAllocator } from "./tools/element-ids.js";
import { initDialogEvents } from "./tools/dialogs.js";
import { runBrowserTool, readOpenTabs } from "./tools/browser-tools.js";

initDialogEvents();
const allocateBrowserId = createBrowserIdAllocator(chrome.storage.local);

declare const __TCHROME_EXECUTOR_VERSION__: string;
const executorVersion = typeof __TCHROME_EXECUTOR_VERSION__ === "string" ? __TCHROME_EXECUTOR_VERSION__ : "unbundled";

const SERVICE = "http://127.0.0.1:18788";
const PUMP_ALARM = "tchrome-tool-pump";
let pumping = false;
let active = false;
// Persist claims before execution so worker restarts never replay an action.
const EXECUTION_RECORDS = "tchrome-tool-executions";
const reported = new Map<string, Record<string, unknown>>();
const tabChains = new Map<number, Promise<void>>();

const withTabLock = async (tabId: number | null | undefined, fn: () => Promise<void>) => {
  if (typeof tabId !== "number" || !Number.isFinite(tabId)) {
    await fn();
    return;
  }
  const prev = tabChains.get(tabId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  tabChains.set(tabId, next.then(() => {}, () => {}));
  await next;
};

const loadRecords = async (): Promise<Record<string, { result?: Record<string, unknown> }>> =>
  ((await chrome.storage.session.get(EXECUTION_RECORDS))[EXECUTION_RECORDS] as Record<string, { result?: Record<string, unknown> }>) ?? {};

const runRequest = async (request: { id: string; name: string; input?: Record<string, unknown> }) => {
  if (reported.has(request.id)) return;
  const records = await loadRecords();
  let result: Record<string, unknown>;
  if (records[request.id]?.result) {
    result = records[request.id]!.result!;
  } else {
    await chrome.storage.session.set({
      [EXECUTION_RECORDS]: { ...records, [request.id]: {} },
    });
    const input = request.input ?? {};
    const tabId = typeof input.tabId === "number" ? input.tabId : null;
    try {
      await withTabLock(tabId, async () => {
        try {
          result = request.name === "__openTabs" ? (await readOpenTabs()) as unknown as Record<string, unknown>
            : (await runBrowserTool(request.name, input)) as Record<string, unknown>;
        } catch (error) {
          result = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      });
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const after = await loadRecords();
    await chrome.storage.session.set({
      [EXECUTION_RECORDS]: { ...after, [request.id]: { result } },
    });
  }
  reported.set(request.id, result!);
  const response = await fetch(`${SERVICE}/tool-result?executorVersion=${executorVersion}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: request.id, result }),
  });
  if (!response.ok) throw new Error(`tool-result ${response.status}`);
};

const pumpTools = async () => {
  if (pumping) return;
  pumping = true;
  try {
    while (true) {
      const listed = await fetch(`${SERVICE}/tool-request?executorVersion=${executorVersion}`);
      const body = await listed.json() as {
        executorVersion?: string;
        requests?: { id: string; name: string; input?: Record<string, unknown> }[];
        request?: { id: string; name: string; input?: Record<string, unknown> } | null;
      };
      // A new extension must also refuse requests from an old service.
      if (!listed.ok || body.executorVersion !== executorVersion) {
        active = false;
        return;
      }
      const requests = body.requests ?? (body.request ? [body.request] : []);
      if (!requests.length) {
        const session = await fetch(`${SERVICE}/session`);
        active = ((await session.json()) as { status?: string }).status === "running";
        return;
      }
      active = true;
      await Promise.all(requests.map((request) => runRequest(request).catch(() => {})));
    }
  } finally {
    pumping = false;
  }
};

// The worker owns dispatch, independently of the side panel's lifetime. Chrome
// API calls reset the MV3 idle timer while a turn or a browser tool is running.
const tick = () => {
  if (active) chrome.runtime.getPlatformInfo(() => {});
  void pumpTools().catch(() => { active = false; });
};
setInterval(tick, 1000);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PUMP_ALARM) tick();
});
// Recreate the alarm whenever the worker starts (alarms may be cleared on restart).
chrome.alarms.create(PUMP_ALARM, { periodInMinutes: 0.5 });

// Side panel cannot reliably navigate itself; open reply links in a normal tab.
chrome.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as { type?: string; url?: string } | null;
  if (msg?.type !== "tchrome.open-url" || typeof msg.url !== "string") return;
  const url = msg.url.trim();
  if (!/^(?:https?|file):/i.test(url)) return;
  void chrome.tabs.create({ url });
});
tick();

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "allocate-browser-id") {
    allocateBrowserId(message.kind).then(
      id => sendResponse({id}),
      error => sendResponse({error: error instanceof Error ? error.message : String(error)}),
    );
    return true;
  }
  if (message?.type === "ping") {
    tick();
    sendResponse({ ok: true });
  }
  return false;
});
