import { createBrowserIdAllocator } from "./tools/element-ids.js";
import { initDialogEvents } from "./tools/dialogs.js";
import { runBrowserTool } from "./tools/browser-tools.js";

initDialogEvents();
const allocateBrowserId = createBrowserIdAllocator(chrome.storage.local);

declare const __TCHROME_EXECUTOR_VERSION__: string;
const executorVersion = typeof __TCHROME_EXECUTOR_VERSION__ === "string" ? __TCHROME_EXECUTOR_VERSION__ : "unbundled";

const SERVICE = "http://127.0.0.1:18788";
const PUMP_ALARM = "tchrome-tool-pump";
let pumping = false;
let active = false;
// Persist the claim before execution so worker restarts never replay an action.
const EXECUTION_RECORD = "tchrome-tool-execution";
let completed: { id: string; result: Record<string, unknown> } | undefined;

const pumpTools = async () => {
  if (pumping) return;
  pumping = true;
  try {
    while (true) {
      const listed = await fetch(`${SERVICE}/tool-request?executorVersion=${executorVersion}`);
      const body = await listed.json() as { executorVersion?: string; request?: { id: string; name: string; input?: Record<string, unknown> } | null };
      // A new extension must also refuse requests from an old service.
      if (!listed.ok || body.executorVersion !== executorVersion) {
        active = false;
        return;
      }
      if (!body.request) {
        const session = await fetch(`${SERVICE}/session`);
        active = ((await session.json()) as { status?: string }).status === "running";
        return;
      }
      active = true;
      if (completed?.id !== body.request.id) {
        const stored = (await chrome.storage.session.get(EXECUTION_RECORD))[EXECUTION_RECORD] as
          { id: string; result?: Record<string, unknown> } | undefined;
        if (stored?.id === body.request.id) {
          completed = { id: stored.id, result: stored.result ?? {
            ok: false, faultCode: "tool_execution_failed",
            error: "扩展执行期间重启，操作结果未知；未重复执行。请检查页面实际状态后再决定下一步。",
          } };
        } else {
          await chrome.storage.session.set({ [EXECUTION_RECORD]: { id: body.request.id } });
          let result: Record<string, unknown>;
          try {
            result = await runBrowserTool(body.request.name, body.request.input ?? {});
          } catch (error) {
            result = { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
          completed = { id: body.request.id, result };
          await chrome.storage.session.set({ [EXECUTION_RECORD]: completed });
        }
      }
      const reported = await fetch(`${SERVICE}/tool-result?executorVersion=${executorVersion}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(completed),
      });
      if (!reported.ok) return;
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
