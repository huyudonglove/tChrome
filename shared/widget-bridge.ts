// 侧栏组件（<tchrome-widget>）的高度回传协议。
// 组件页由 service/widgets/store.ts 在读取时注入 WIDGET_FIT_SCRIPT；
// 页面把自身文档高度 postMessage 给父页，extension/sidepanel/App.tsx 据此调整 iframe 高度。
// 两侧共用本模块，避免协议字符串各写一份而走偏。
export const WIDGET_HEIGHT_MESSAGE = "tchrome-widget-height";
export const WIDGET_DEFAULT_HEIGHT = 300;
export const WIDGET_MIN_HEIGHT = 80;
export const WIDGET_MAX_HEIGHT = 1200;

export const WIDGET_FIT_SCRIPT = [
  "<script>",
  "(function () {",
  "  var send = function () {",
  "    try {",
  "      var doc = document.documentElement, body = document.body;",
  "      var height = Math.max(doc ? doc.scrollHeight : 0, body ? body.scrollHeight : 0);",
  "      if (height > 0) parent.postMessage({ type: '" + WIDGET_HEIGHT_MESSAGE + "', height: height }, '*');",
  "    } catch (error) { /* 父页不可达时保持静默，组件自身仍可正常使用 */ }",
  "  };",
  "  window.addEventListener('load', send);",
  "  if (typeof ResizeObserver === 'function' && document.documentElement) {",
  "    new ResizeObserver(send).observe(document.documentElement);",
  "  }",
  "  send();",
  "})();",
  "</script>",
].join("\n");

// 父页侧：只接受本协议的消息，高度取整并夹在 [MIN, MAX] 内；无效消息返回 null。
export function resolveWidgetHeight(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const message = data as { type?: unknown; height?: unknown };
  if (message.type !== WIDGET_HEIGHT_MESSAGE) return null;
  const height = Number(message.height);
  if (!Number.isFinite(height) || height <= 0) return null;
  return Math.min(Math.max(Math.round(height), WIDGET_MIN_HEIGHT), WIDGET_MAX_HEIGHT);
}
