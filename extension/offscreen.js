// Offscreen document: performs clipboard access in a context that does not
// depend on a visible, focused page.
//
// navigator.clipboard is not usable here: an offscreen document is never
// visible, therefore never focused, and both writeText and readText reject
// with "Document is not focused". The legacy textarea + execCommand path has
// no focus requirement in an extension context that holds the clipboardRead /
// clipboardWrite permissions, so both directions use it.
const target = () => {
  let el = document.getElementById('clipboard-target');
  if (!el) {
    el = document.createElement('textarea');
    el.id = 'clipboard-target';
    document.body.appendChild(el);
  }
  return el;
};

const writeClipboard = async (text) => {
  const el = target();
  el.value = text;
  el.select();
  const ok = document.execCommand('copy');
  el.value = '';
  return ok ? { ok: true, bytes: text.length } : { ok: false, error: 'execCommand("copy") 被拒绝' };
};

const readClipboard = async () => {
  const el = target();
  el.value = '';
  el.select();
  const ok = document.execCommand('paste');
  const text = el.value;
  el.value = '';
  return ok ? { ok: true, text, bytes: String(text).length } : { ok: false, error: 'execCommand("paste") 被拒绝' };
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return false;
  const task =
    message.type === 'clipboard_write'
      ? writeClipboard(String(message.text ?? ''))
      : message.type === 'clipboard_read'
        ? readClipboard()
        : null;
  if (!task) return false;
  task.then(sendResponse, (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});
