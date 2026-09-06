import { runBrowserTool } from "./browser.ts";

const SERVICE = "http://127.0.0.1:18788";
let pumping = false;

const pumpTools = async () => {
  if (pumping) return;
  pumping = true;
  try {
    while (true) {
      const listed = await fetch(`${SERVICE}/tool-request`);
      const body = await listed.json() as { request?: { id: string; name: string; input?: Record<string, unknown> } | null };
      if (!body.request) return;
      let result: Record<string, unknown>;
      try {
        result = await runBrowserTool(body.request.name, body.request.input ?? {});
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      await fetch(`${SERVICE}/tool-result`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: body.request.id, result }),
      });
    }
  } finally {
    pumping = false;
  }
};

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ping") {
    pumpTools().catch(() => {});
    sendResponse({ ok: true });
  }
  return false;
});
