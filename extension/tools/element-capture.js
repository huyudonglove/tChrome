import { withDebugger } from './dialogs.js';

// Executed in the same isolated world that owns snapshot/find element refs.
export function elementBounds(input) {
  let node;
  if (input.ref !== undefined) {
    if (typeof input.ref !== 'string' || !input.ref.startsWith('el-')) return {ok: false, faultCode: 'invalid_ref', error: 'ref 必须来自 snapshot_page/find_on_page；CSS 选择器请使用 selector'};
    node = globalThis.__tChromeElementRefs?.refs.get(input.ref);
    if (!node?.isConnected) return {ok: false, faultCode: 'stale_ref', error: '元素 ref 已失效，请重新查找'};
  } else {
    try {
      const matches = document.querySelectorAll(input.selector);
      if (matches.length !== 1) return {ok: false, faultCode: matches.length ? 'ambiguous_target' : 'target_not_found', error: matches.length ? 'selector 匹配多个元素，请缩小范围' : '未找到元素'};
      node = matches[0];
    } catch { return {ok: false, faultCode: 'invalid_selector', error: '无效 CSS 选择器'}; }
  }
  const rect = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  if (!rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return {ok: false, faultCode: 'element_not_visible', error: '元素没有可截图的可见区域'};
  return {ok: true, pixelRatio: devicePixelRatio, rect: {x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height}};
}

export async function captureElement(tabId, input) {
  const hasRef = typeof input.ref === 'string' && input.ref.trim().length > 0;
  const hasSelector = typeof input.selector === 'string' && input.selector.trim().length > 0;
  if (hasRef === hasSelector || (input.ref !== undefined && !hasRef) || (input.selector !== undefined && !hasSelector)) return {ok: false, error: '必须且只能提供 ref 或 selector'};
  const [{result}] = await chrome.scripting.executeScript({target: {tabId}, func: elementBounds, args: [input]});
  if (!result?.ok) return {tab: tabId, ...result, ok: false};
  return withDebugger(tabId, async () => {
    const metrics = await chrome.debugger.sendCommand({tabId}, 'Page.getLayoutMetrics');
    const size = metrics.cssContentSize;
    if (!size) return {ok: false, error: '无法读取页面尺寸'};
    const r = result.rect;
    const x = Math.max(r.x, size.x ?? 0);
    const y = Math.max(r.y, size.y ?? 0);
    const width = Math.min(r.x + r.width, (size.x ?? 0) + size.width) - x;
    const height = Math.min(r.y + r.height, (size.y ?? 0) + size.height) - y;
    if (![x,y,width,height].every(Number.isFinite) || width <= 0 || height <= 0) return {ok: false, error: '元素位于可截图的页面范围之外'};
    const ratio = Number(result.pixelRatio) > 0 ? Number(result.pixelRatio) : 1;
    if (width * ratio > 16000 || height * ratio > 16000 || width * height * ratio * ratio > 32000000) return {ok: false, faultCode: 'element_too_large', error: '元素超出截图上限（边长16000、3200万像素）'};
    const shot = await chrome.debugger.sendCommand({tabId}, 'Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: true, clip: {x,y,width,height,scale:1},
    });
    if (!shot?.data) return {ok: false, error: '浏览器未返回截图'};
    return {ok: true, tab: tabId, image: `data:image/png;base64,${shot.data}`, mime: 'image/png',
      element_rect: r, capture_rect: {x,y,width,height}, clipped: x !== r.x || y !== r.y || width !== r.width || height !== r.height};
  }, {retryDetached: false});
}
