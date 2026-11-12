// 可见光标覆盖层：把代理的鼠标动作显示在页面上，让用户看得到"操作到了哪里"。
// 覆盖层装在页面上下文里，随页面自身收到的 mousedown/mousemove/click 移动；
// 元素级合成动作（el.click()、dispatchEvent）不产生真实鼠标事件，由 element-tools.js 显式调用 moveTo。
import { withDebugger } from './dialogs.js';

const CURSOR_ID = 'tchrome-cursor';
const CURSOR_NS = '__tChromeCursor';

/** 在页面上下文里执行：安装（或复用）光标覆盖层并返回安装结果。 */
export const installVisualCursor = (cursorId, ns) => {
  const doc = document;
  const prev = window[ns];
  const prevHost = doc.getElementById(cursorId);
  if (prev && prevHost && typeof prev.moveTo === 'function') {
    prev.ensure();
    prev.show();
    return {installed: false, reused: true, ...prev.pos()};
  }
  // 早前的实验性注入可能残留带缺陷的监听器，先中和掉，避免页面上继续抛错。
  if (window.__helmCursor) {
    window.__helmCursor = {moveTo() {}, pulse() {}, hide() {}};
  }
  doc.getElementById('helm-vcursor')?.remove();
  prevHost?.remove();

  const host = doc.createElement('div');
  host.id = cursorId;
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;'
    + 'transform:translate3d(-120px,-120px,0);transition:transform .12s ease-out;opacity:0;will-change:transform';

  const arrow = doc.createElement('div');
  arrow.style.cssText =
    'position:absolute;left:0;top:0;width:22px;height:22px;transform-origin:2px 2px;'
    + 'filter:drop-shadow(0 1px 3px rgba(0,0,0,.5));transition:transform .08s ease-out';
  arrow.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24">'
    + '<path d="M5.4 2.6V19.4L10 14.9L13 21.2L16.1 19.7L13.2 13.5L19.6 13.2Z" '
    + 'fill="#ffffff" stroke="#0f172a" stroke-width="1.3" stroke-linejoin="round"/></svg>';

  const ripple = doc.createElement('div');
  ripple.style.cssText =
    'position:absolute;left:-15px;top:-15px;width:30px;height:30px;border-radius:50%;'
    + 'border:2px solid rgba(34,211,238,.95);opacity:0';

  host.append(arrow, ripple);
  (doc.body || doc.documentElement).append(host);

  let x = -120;
  let y = -120;
  let fadeTimer = 0;
  const show = () => {
    host.style.opacity = '1';
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      host.style.opacity = '.4';
    }, 2500);
  };
  const pulse = () => {
    ripple.animate(
      [{opacity: .95, transform: 'scale(.4)'}, {opacity: 0, transform: 'scale(1.6)'}],
      {duration: 520, easing: 'cubic-bezier(.2,.8,.3,1)'},
    );
    arrow.animate([{transform: 'scale(.82)'}, {transform: 'scale(1)'}], {duration: 180, easing: 'ease-out'});
  };
  const api = {
    version: 1,
    moveTo(nx, ny, withPulse = false) {
      x = Math.round(nx);
      y = Math.round(ny);
      host.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      show();
      if (withPulse) pulse();
      return {x, y};
    },
    pulse,
    show,
    hide() {
      host.style.opacity = '0';
    },
    pos() {
      return {x, y};
    },
    ensure() {
      if (!host.isConnected) (doc.body || doc.documentElement).append(host);
    },
  };
  window[ns] = api;

  const track = (event) => {
    const cur = window[ns];
    if (!cur || typeof cur.moveTo !== 'function') return;
    if (typeof event.clientX !== 'number' || (event.clientX === 0 && event.clientY === 0)) return;
    cur.moveTo(event.clientX, event.clientY, false);
  };
  const press = (event) => {
    const cur = window[ns];
    if (!cur || typeof cur.moveTo !== 'function') return;
    if (typeof event.clientX !== 'number') return;
    cur.moveTo(event.clientX, event.clientY, true);
  };
  if (!window.__tchromeCursorBound) {
    window.__tchromeCursorBound = true;
    window.addEventListener('pointerdown', press, true);
    window.addEventListener('mousedown', press, true);
    window.addEventListener('pointermove', track, true);
    window.addEventListener('mousemove', track, true);
    window.addEventListener('click', track, true);
  }
  show();
  return {installed: true, reused: false, x, y};
};

/** 确保目标标签页里有光标覆盖层；页面导航会清掉它，所以每次鼠标动作前都调用（复用很便宜）。 */
const registeredTabs = new Set();

/** 页面导航会清空覆盖层，注册一次新文档脚本让后续每次导航自动装上，省掉重复安装。 */
const registerOnNewDocument = async (tabId) => {
  if (registeredTabs.has(tabId)) return;
  registeredTabs.add(tabId);
  try {
    await withDebugger(tabId, () => chrome.debugger.sendCommand({tabId}, 'Page.addScriptToEvaluateOnNewDocument', {
      source: `(${installVisualCursor.toString()})(${JSON.stringify(CURSOR_ID)}, ${JSON.stringify(CURSOR_NS)});`,
    }));
  } catch {
    // 注册失败不影响当前文档里的安装，下一次鼠标动作会重试安装
    registeredTabs.delete(tabId);
  }
};

export const ensureVisualCursor = async (tabId) => {
  if (!Number.isInteger(tabId)) return {ok: false, error: '缺少 tabId'};
  try {
    await registerOnNewDocument(tabId);
    const evaluated = await withDebugger(tabId, () => chrome.debugger.sendCommand(
      {tabId},
      'Runtime.evaluate',
      {
        expression: `(${installVisualCursor.toString()})(${JSON.stringify(CURSOR_ID)}, ${JSON.stringify(CURSOR_NS)})`,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true,
      },
    ));
    const remote = evaluated?.result;
    if (!remote?.value) {
      return {ok: false, error: '光标覆盖层未安装', detail: evaluated?.exceptionDetails?.text || ''};
    }
    return {ok: true, ...remote.value};
  } catch (error) {
    return {ok: false, error: String(error)};
  }
};

/**
 * 把光标移到指定点。元素级动作（el.click()/dispatchEvent）不产生真实鼠标事件，
 * 且 elementTool 跑在扩展隔离世界读不到主世界的光标 API，所以由扩展侧带着坐标调这里，
 * 用 Runtime.evaluate 在主世界执行 moveTo。
 */
export const moveVisualCursor = async (tabId, point) => {
  if (!Number.isInteger(tabId) || !point) return {ok: false, error: '缺少 tabId 或坐标'};
  const x = Math.round(Number(point.x));
  const y = Math.round(Number(point.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return {ok: false, error: '坐标无效'};
  const installed = await ensureVisualCursor(tabId);
  if (!installed.ok) return installed;
  try {
    const evaluated = await withDebugger(tabId, () => chrome.debugger.sendCommand(
      {tabId},
      'Runtime.evaluate',
      {
        expression: `(() => { const c = window[${JSON.stringify(CURSOR_NS)}];`
          + ` if (!c || typeof c.moveTo !== 'function') return {moved: false};`
          + ` if (typeof c.ensure === 'function') c.ensure();`
          + ` return {moved: true, ...c.moveTo(${x}, ${y}, ${point.pulse === false ? 'false' : 'true'})}; })()`,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true,
      },
    ));
    const remote = evaluated?.result?.value;
    if (!remote?.moved) return {ok: false, error: '光标未移动', detail: evaluated?.exceptionDetails?.text || ''};
    return {ok: true, ...remote};
  } catch (error) {
    return {ok: false, error: String(error)};
  }
};

export const CURSOR_ELEMENT_ID = CURSOR_ID;
export const CURSOR_GLOBAL_NAME = CURSOR_NS;
