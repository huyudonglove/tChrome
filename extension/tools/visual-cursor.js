// 可见光标覆盖层：把代理的鼠标动作显示在页面上，让用户看得到"操作到了哪里"。
// 光标位置只由扩展侧驱动（CDP 派发前用 Runtime.evaluate 显式 moveTo），
// 不监听页面自身的鼠标事件，所以不会跟随用户自己的光标移动。
// 每次动作后闲置一小段时间自动淡出并隐藏，用完即消失。
import { withDebugger } from './dialogs.js';

const CURSOR_ID = 'tchrome-cursor';
const CURSOR_NS = '__tChromeCursor';

/** 在页面上下文里执行：安装（或复用）光标覆盖层并返回安装结果。 */
export const installVisualCursor = (cursorId, ns) => {
  const doc = document;
  const prev = window[ns];
  const prevHost = doc.getElementById(cursorId);
  // 只复用版本匹配的覆盖层；旧版带真实鼠标监听，必须重建后由 allow 许可挡住旧监听。
  if (prev && prevHost && typeof prev.moveTo === 'function' && prev.version >= 2) {
    prev.ensure();
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
    + 'transform:translate3d(-120px,-120px,0);transition:transform .12s ease-out,opacity .3s ease-out;opacity:0;will-change:transform';

  const arrow = doc.createElement('div');
  arrow.style.cssText =
    'position:absolute;left:0;top:0;width:22px;height:22px;transform-origin:2px 2px;'
    + 'filter:drop-shadow(0 1px 3px rgba(0,0,0,.5));transition:transform .08s ease-out';
  arrow.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24">'
    + '<path d="M5.4 2.6V19.4L10 14.9L13 21.2L16.1 19.7L13.2 13.5L19.6 13.2Z" '
    + 'fill="#22d3ee" stroke="#0b1220" stroke-width="1.6" stroke-linejoin="round"/></svg>';

  const ripple = doc.createElement('div');
  ripple.style.cssText =
    'position:absolute;left:-15px;top:-15px;width:30px;height:30px;border-radius:50%;'
    + 'border:2px solid rgba(34,211,238,.95);opacity:0';

  host.append(arrow, ripple);
  (doc.body || doc.documentElement).append(host);

  let x = -120;
  let y = -120;
  let fadeTimer = 0;
  let hideTimer = 0;
  let allowUntil = 0;

  const show = () => {
    host.style.opacity = '1';
    clearTimeout(fadeTimer);
    clearTimeout(hideTimer);
    // 动作停下后先淡出、再完全隐藏：光标只在操作期间可见。
    fadeTimer = setTimeout(() => { host.style.opacity = '.5'; }, 1400);
    hideTimer = setTimeout(() => { host.style.opacity = '0'; }, 2400);
  };
  const pulse = () => {
    ripple.animate(
      [{opacity: .95, transform: 'scale(.4)'}, {opacity: 0, transform: 'scale(1.6)'}],
      {duration: 520, easing: 'cubic-bezier(.2,.8,.3,1)'},
    );
    arrow.animate([{transform: 'scale(.82)'}, {transform: 'scale(1)'}], {duration: 180, easing: 'ease-out'});
  };
  const api = {
    version: 2,
    // 扩展侧移动光标前先声明"这次是我发的"；页面自身的鼠标事件不带这个许可，会被忽略。
    allow(ms = 400) {
      allowUntil = Date.now() + ms;
      return true;
    },
    moveTo(nx, ny, withPulse = false) {
      if (Date.now() > allowUntil) return {x, y, ignored: true};
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
      clearTimeout(fadeTimer);
      clearTimeout(hideTimer);
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
 * 把光标移到指定点。所有动作（CDP 派发的鼠标事件、元素级合成点击、page.* 交互）
 * 都走这里显式定位，页面自身的鼠标事件不参与，因此光标不会跟随用户自己的鼠标。
 */
export const moveVisualCursor = async (tabId, point) => {
  if (!Number.isInteger(tabId) || !point) return {ok: false, error: '缺少 tabId 或坐标'};
  const x = Math.round(Number(point.x));
  const y = Math.round(Number(point.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return {ok: false, error: '坐标无效'};
  const expression = `(() => { const c = window[${JSON.stringify(CURSOR_NS)}];`
    + ` if (!c || typeof c.moveTo !== 'function') return {moved: false};`
    + ` if (typeof c.ensure === 'function') c.ensure();`
    // 旧版（version 1）监听页面真实鼠标，必须升级重建，否则光标还会跟着用户的鼠标跑。
    + ` if (!(c.version >= 2)) return {moved: false, stale: true};`
    + ` if (typeof c.allow === 'function') c.allow(600);`
    + ` const r = c.moveTo(${x}, ${y}, ${point.pulse === false ? 'false' : 'true'});`
    + ` return {moved: !(r && r.ignored), x: ${x}, y: ${y}}; })()`;
  const evaluate = async () => {
    const evaluated = await withDebugger(tabId, () => chrome.debugger.sendCommand(
      {tabId},
      'Runtime.evaluate',
      {expression, returnByValue: true, allowUnsafeEvalBlockedByCSP: true},
    ));
    return evaluated?.result?.value ?? null;
  };
  try {
    let remote = await evaluate();
    if (!remote?.moved) {
      // 页面刚导航或首次安装时覆盖层还不存在，装一次再重试。
      const installed = await ensureVisualCursor(tabId);
      if (!installed.ok) return installed;
      remote = await evaluate();
    }
    if (!remote?.moved) return {ok: false, error: '光标未移动'};
    return {ok: true, x: remote.x, y: remote.y};
  } catch (error) {
    return {ok: false, error: String(error)};
  }
};

export const CURSOR_ELEMENT_ID = CURSOR_ID;
export const CURSOR_GLOBAL_NAME = CURSOR_NS;
