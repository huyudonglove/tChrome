import { withDebugger } from './dialogs.js';

// Executed in the same isolated world that owns snapshot/find element refs.
export function elementBounds(input) {
  let node;
  if (input.ref !== undefined) {
    if (typeof input.ref !== 'string' || !/^(?:e|r)_[0-9]{2,}$/.test(input.ref)) return {ok: false, faultCode: 'invalid_ref', error: 'ref 必须是 page.* 或 snapshot 返回的 e_/r_ 编号；CSS 选择器请使用 selector'};
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

/** Collect visible interactive nodes, inject numbered overlay badges, return marks (viewport CSS px). */
export async function somAnnotate(options = {}) {
  const maxMarks = Math.min(80, Math.max(1, Number(options.maxMarks) || 40));
  const roleFilter = Array.isArray(options.roles) && options.roles.length
    ? new Set(options.roles.map((r) => String(r).toLowerCase()))
    : null;
  const selector = 'a,button,input:not([type=hidden]),textarea,select,summary,[contenteditable="true"],[role="button"],[role="link"],[role="textbox"],[role="tab"],[role="checkbox"],[role="radio"],[role="combobox"],[role="menuitem"]';
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width >= 2 && rect.height >= 2
      && rect.bottom > 0 && rect.right > 0
      && rect.top < innerHeight && rect.left < innerWidth
      && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
      && style.pointerEvents !== 'none';
  };
  const roleOf = (node) => {
    const role = (node.getAttribute('role') || '').toLowerCase();
    if (role) return role;
    const tag = node.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') return (node.type || 'textbox').toLowerCase();
    return tag;
  };
  const labelOf = (node) => {
    const explicit = node.id ? document.querySelector(`label[for="${CSS.escape(node.id)}"]`)?.innerText : '';
    return (explicit || node.closest('label')?.innerText || node.getAttribute('aria-label') || node.innerText || node.value || '').trim().slice(0, 80);
  };

  const state = globalThis.__tChromeElementRefs ??= {refs: new Map(), ids: new WeakMap()};
  const pageState = globalThis.__tChromePageIds ??= {pageElement: new WeakMap(), pageRegion: new WeakMap()};
  for (const [ref, node] of state.refs) if (!node?.isConnected) state.refs.delete(ref);

  const refOf = async (node) => {
    if (!pageState.pageElement.has(node)) {
      pageState.pageElement.set(node, chrome.runtime.sendMessage({type: 'allocate-browser-id', kind: 'pageElement'}).then((result) => {
        if (!result?.id) throw new Error(result?.error || '无法分配元素编号');
        return result.id;
      }));
    }
    const ref = await pageState.pageElement.get(node);
    state.refs.set(ref, node);
    state.ids.set(node, ref);
    return ref;
  };

  let nodes = [...document.querySelectorAll(selector)].filter(visible);
  if (roleFilter) {
    const filtered = nodes.filter((node) => roleFilter.has(roleOf(node)));
    if (filtered.length) nodes = filtered;
  }
  nodes.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return (rb.width * rb.height) - (ra.width * ra.height);
  });
  nodes = nodes.slice(0, maxMarks);

  const marks = [];
  for (const node of nodes) {
    let id;
    try { id = await refOf(node); } catch { continue; }
    const rect = node.getBoundingClientRect();
    const role = roleOf(node);
    marks.push({
      badge: marks.length + 1,
      id,
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      role,
      name: labelOf(node),
      tag: node.tagName.toLowerCase(),
    });
  }

  document.getElementById('__tchrome_som_overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = '__tchrome_som_overlay';
  overlay.setAttribute('data-tchrome-som', '1');
  overlay.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;pointer-events:none!important;background:transparent;';
  for (const mark of marks) {
    const box = document.createElement('div');
    box.style.cssText = `position:absolute;left:${mark.x}px;top:${mark.y}px;width:${mark.w}px;height:${mark.h}px;box-sizing:border-box;outline:1.5px solid rgba(255,59,48,.9);outline-offset:-1px;background:rgba(255,59,48,.08);`;
    const badge = document.createElement('span');
    badge.textContent = String(mark.badge);
    badge.style.cssText = `position:absolute;left:0;top:0;min-width:16px;height:16px;padding:0 3px;border-radius:8px;background:#ff3b30;color:#fff;font:600 11px/16px -apple-system,BlinkMacSystemFont,sans-serif;text-align:center;z-index:2147483647;pointer-events:none;`;
    box.appendChild(badge);
    overlay.appendChild(box);
  }
  document.documentElement.appendChild(overlay);
  return {
    ok: true,
    pixelRatio: devicePixelRatio || 1,
    viewport: [innerWidth, innerHeight],
    marks,
    total: marks.length,
  };
}

export function somClear() {
  document.getElementById('__tchrome_som_overlay')?.remove();
  return {ok: true};
}

export async function captureElement(tabId, input) {
  const hasRef = typeof input.ref === 'string' && input.ref.trim().length > 0;
  const hasSelector = typeof input.selector === 'string' && input.selector.trim().length > 0;
  if (hasRef === hasSelector || (input.ref !== undefined && !hasRef) || (input.selector !== undefined && !hasSelector)) return {ok: false, error: '必须且只能提供 ref 或 selector'};
  const [{result}] = await chrome.scripting.executeScript({target: {tabId}, func: elementBounds, args: [input]});
  if (!result?.ok) return {tabId: tabId, ...result, ok: false};
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
    return {ok: true, tabId: tabId, image: `data:image/png;base64,${shot.data}`, mime: 'image/png',
      element_rect: r, capture_rect: {x,y,width,height}, clipped: x !== r.x || y !== r.y || width !== r.width || height !== r.height};
  }, {retryDetached: false});
}

/** Set-of-Marks viewport capture: annotate interactives, screenshot, always clear overlay. */
export async function captureSom(tabId, input) {
  const maxMarks = input.maxMarks;
  const roles = Array.isArray(input.roles) ? input.roles.filter((r) => typeof r === 'string' && r.trim()) : undefined;
  let annotate;
  try {
    const [{result}] = await chrome.scripting.executeScript({
      target: {tabId},
      func: somAnnotate,
      args: [{maxMarks, roles}],
    });
    annotate = result;
  } catch (error) {
    return {ok: false, tabId, error: error instanceof Error ? error.message : String(error)};
  }
  if (!annotate?.ok) return {tabId, ...(annotate || {}), ok: false};
  try {
    return await withDebugger(tabId, async () => {
      const shot = await chrome.debugger.sendCommand({tabId}, 'Page.captureScreenshot', {
        format: 'jpeg', quality: 75, fromSurface: true, captureBeyondViewport: false,
      });
      if (!shot?.data) return {ok: false, error: '浏览器未返回截图'};
      const image = `data:image/jpeg;base64,${shot.data}`;
      return {
        ok: true,
        tabId,
        mode: 'som',
        image,
        mime: 'image/jpeg',
        image_size: null,
        viewport: annotate.viewport,
        devicePixelRatio: annotate.pixelRatio,
        marks: annotate.marks,
        total: annotate.total,
        note: 'marks 为视口 CSS 像素；点击用 marks[].id 作为 page.click 的 id/ref',
      };
    }, {retryDetached: false});
  } catch (error) {
    return {ok: false, tabId, error: error instanceof Error ? error.message : String(error)};
  } finally {
    try {
      await chrome.scripting.executeScript({target: {tabId}, func: somClear});
    } catch { /* ignore */ }
  }
}
