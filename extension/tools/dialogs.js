// Browser protocol state stays outside page JavaScript, which native dialogs block.
const attached = new Set();
const enabled = new Set();
const states = new Map();
const watchers = new Map();
let eventSource;
export const dialogState = (tab) => states.get(tab) ?? {status: 'unknown'};
export const initDialogEvents = () => {
  if (!globalThis.chrome?.debugger?.onEvent || eventSource === chrome.debugger.onEvent) return;
  eventSource = chrome.debugger.onEvent;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tab = source.tabId;
    if (tab == null) return;
    if (method === 'Page.javascriptDialogOpening') {
      const dialog = {status: 'open', type: params.type, message: params.message, url: params.url,
        defaultPrompt: params.defaultPrompt, observedAt: new Date().toISOString()};
      states.set(tab, dialog);
      for (const notify of watchers.get(tab) ?? []) notify(dialog);
    } else if (method === 'Page.javascriptDialogClosed') {
      states.set(tab, {status: 'closed', observedAt: new Date().toISOString()});
    }
  });
  chrome.debugger.onDetach.addListener(({tabId}) => {
    attached.delete(tabId); enabled.delete(tabId); states.delete(tabId);
  });
  chrome.tabs.onRemoved.addListener((tab) => {
    attached.delete(tab); enabled.delete(tab); states.delete(tab); watchers.delete(tab);
  });
};
export const withDebugger = async (tabId, run) => {
  initDialogEvents();
  const attach = async () => {
    if (!attached.has(tabId)) {
      await chrome.debugger.attach({tabId}, '1.3');
      attached.add(tabId);
    }
  };
  await attach();
  try { return await run(); }
  catch (error) {
    if (/not attached|Detached|Debugger is not attached/i.test(String(error))) {
      attached.delete(tabId); enabled.delete(tabId); states.delete(tabId);
    }
    throw error;
  }
};
export const detachDebugger = async (tabId) => {
  initDialogEvents();
  try {
    await chrome.debugger.detach({tabId});
  } catch (error) {
    // Treat benign or already-detached errors as success
    if (!/not attached|Detached|Debugger is not attached/i.test(String(error))) {
      throw error;
    }
  }
  attached.delete(tabId);
  enabled.delete(tabId);
  states.delete(tabId);
  return {ok: true, tabId: tabId, detached: true};
};
export const monitorDialogs = async (tab) => {
  await withDebugger(tab, async () => {
    if (!enabled.has(tab)) {
      await chrome.debugger.sendCommand({tabId: tab}, 'Page.enable');
      enabled.add(tab);
    }
  });
  return dialogState(tab);
};
export const watchDialog = (tab, notify) => {
  if (!watchers.has(tab)) watchers.set(tab, new Set());
  watchers.get(tab).add(notify);
  return () => { watchers.get(tab)?.delete(notify); if (!watchers.get(tab)?.size) watchers.delete(tab); };
};
export const handleDialog = async (tab, input) => {
  if (!['accept', 'dismiss'].includes(input.action)) return {ok: false, error: '需要 action=accept|dismiss'};
  if (input.promptText !== undefined && typeof input.promptText !== 'string') return {ok: false, error: 'promptText 必须是字符串'};
  try {
    // Do not require an opening event: the dialog may predate our attachment.
    const previous = dialogState(tab);
    await withDebugger(tab, () => chrome.debugger.sendCommand({tabId: tab}, 'Page.handleJavaScriptDialog', {
      accept: input.action === 'accept', ...(input.promptText !== undefined ? {promptText: input.promptText} : {}),
    }));
    if (dialogState(tab) === previous || dialogState(tab).status === 'unknown') states.set(tab, {status: 'closed', observedAt: new Date().toISOString()});
    // A closing event may already have been followed by a new opening event.
    return {ok: true, tab, action: input.action, dialog: dialogState(tab)};
  } catch (error) {
    const missing = /no (javascript )?dialog|not showing.*dialog/i.test(String(error));
    if (missing) states.set(tab, {status: 'closed', observedAt: new Date().toISOString()});
    return {ok: false, tab, faultCode: missing ? 'no_dialog' : 'dialog_handle_failed', error: String(error), dialog: dialogState(tab)};
  }
};
