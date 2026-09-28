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
// A service that keeps rejecting /tool-result must not turn the pump into a hot
// loop: retry a few times with backoff, then give up so the next tick can try
// again instead of starving timers while re-polling the same undelivered id.
const REPORT_FAILURE_LIMIT = 3;
const REPORT_BACKOFF_BASE_MS = 20;
const REPORT_BACKOFF_MAX_MS = 200;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
// Persist claims before execution so worker restarts never replay an action.
const EXECUTION_RECORDS = "tchrome-tool-executions";
// A claim without a result normally means a previous worker died mid-execution
// and the action may already have run, so it is never replayed. But MV3 kills
// the worker after ~30s of idleness, which strands long tools (screenshots) the
// same way. Past this TTL the record cannot belong to a live worker, so treat
// it as expired and let the request run again.
const CLAIM_TTL_MS = 60_000;
// One hung renderer (executeScript against a stalled tab) must not wedge the
// pump forever: every execution gets a hard deadline above any legitimate wait
// tool (max 15s), then reports tool_timeout so the service turn can proceed.
const TOOL_EXEC_TIMEOUT_MS = 60_000;
const reported = new Map<string, Record<string, unknown>>();
// Ids whose result the service refused; they must not be re-executed, but the
// pump has to notice that the same id keeps coming back undelivered.
const awaitingReport = new Set<string>();
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

type ExecutionRecord = { claimedAt?: number; result?: Record<string, unknown> };

const loadRecords = async (): Promise<Record<string, ExecutionRecord>> =>
  ((await chrome.storage.session.get(EXECUTION_RECORDS))[EXECUTION_RECORDS] as Record<string, ExecutionRecord>) ?? {};

const runRequest = async (request: { id: string; name: string; input?: Record<string, unknown> }) => {
  if (reported.has(request.id)) return;
  const records = await loadRecords();
  // Seeded so the definite-assignment check holds when a tool throws outside
  // the inner try; every real path overwrites it before it is reported.
  let result: Record<string, unknown> = {
    ok: false,
    faultCode: "tool_execution_failed",
    error: `request ${request.id} produced no result`,
  };
  const claim = records[request.id];
  // Records written before claimedAt existed stay un-replayable: an untimed
  // claim may belong to a worker that ran the action but died before reporting.
  const expired = !!claim && !claim.result
    && typeof claim.claimedAt === "number"
    && Date.now() - claim.claimedAt > CLAIM_TTL_MS;
  if (claim?.result) {
    result = claim.result!;
  } else if (claim && !expired) {
    // A claim without a result means a previous worker stopped mid-execution.
    // The action may already have run, so never replay it: report the failure
    // and let the service decide whether to retry.
    result = {
      ok: false,
      faultCode: "tool_execution_failed",
      error: `request ${request.id} was claimed but never completed by a previous worker`,
    };
  } else {
    await chrome.storage.session.set({
      [EXECUTION_RECORDS]: { ...records, [request.id]: { claimedAt: Date.now() } },
    });
    const input = request.input ?? {};
    const tabId = typeof input.tabId === "number" ? input.tabId : null;
    try {
      await withTabLock(tabId, async () => {
        const work = (async () => {
          try {
            return request.name === "__openTabs" ? (await readOpenTabs()) as unknown as Record<string, unknown>
              : (await runBrowserTool(request.name, input)) as Record<string, unknown>;
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        })();
        // The tab-lock chain only advances when this callback resolves, so the
        // watchdog lives inside it. Late work keeps running detached and can no
        // longer write `result`, so a hung renderer cannot wedge the pump.
        const outcome = await Promise.race([
          work.then((value) => ({ done: true as const, value })),
          sleep(TOOL_EXEC_TIMEOUT_MS).then(() => ({ done: false as const, value: null })),
        ]);
        result = outcome.done ? outcome.value : {
          ok: false,
          faultCode: "tool_timeout",
          error: `${request.name} 执行超时（${TOOL_EXEC_TIMEOUT_MS}ms 看门狗），页面或浏览器执行挂死；可停止本轮后换标签重试`,
        };
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
  if (!response.ok) {
    awaitingReport.add(request.id);
    throw new Error(`tool-result ${response.status}`);
  }
  awaitingReport.delete(request.id);
};

const pumpTools = async () => {
  if (pumping) return;
  pumping = true;
  let reportFailures = 0;
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
      const undelivered = requests.filter((request) => awaitingReport.has(request.id)).length;
      reportFailures = undelivered ? reportFailures + undelivered : 0;
      if (reportFailures >= REPORT_FAILURE_LIMIT) {
        active = false;
        return;
      }
      if (reportFailures) {
        await sleep(Math.min(REPORT_BACKOFF_BASE_MS * 2 ** (reportFailures - 1), REPORT_BACKOFF_MAX_MS));
      }
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
