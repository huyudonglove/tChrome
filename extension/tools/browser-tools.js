export const BROWSER_TOOL_NAMES = [
  'page.get_summary', 'page.list_regions', 'page.list_interactive_elements',
  'page.inspect_region', 'page.inspect_element', 'page.get_dom',
  'page.get_accessibility_tree', 'page.get_element_state',
  'page.click', 'page.type',
  'see_page', 'find_on_page', 'extract_table', 'check_page',
  'snapshot_page', 'watch_page', 'see_page_info',
  'click', 'double_click', 'focus', 'hover',
  'tick', 'select', 'drag', 'calibrate_drag', 'click_xy',
  'type', 'submit', 'press', 'scroll', 'scroll_to',
  'wait', 'wait_network', 'attach_file', 'clear_file', 'clipboard',
  'open_url', 'reload', 'go_history',
  'list_tabs', 'list_windows', 'switch_tab', 'open_tab', 'close_tab',
  'duplicate_tab', 'move_tab', 'update_tab', 'create_window', 'update_window',
  'close_window', 'group_tabs', 'ungroup_tabs',
  'screenshot', 'screenshot_full', 'screenshot_one',
  'save_pdf', 'download', 'wait_download', 'control_download', 'export_data',
  'cookies', 'read_page_credentials', 'page_storage', 'indexeddb',
  'cache_storage', 'capture_network_traffic', 'profile_vault',
  'execute_javascript', 'handle_dialog', 'see_zoom', 'set_zoom',
  'bind_tab', 'see_env', 'list_downloads', 'see_diag', 'see_console', 'wait_popup',
  'list_browser_tools', 'measure_timing', 'measure_paint', 'measure_files',
  'see_captcha', 'wait_captcha', 'click_captcha', 'solve_captcha',
  'emulate_device', 'network_throttle', 'set_cookie', 'delete_cookie', 'clear_cookies',
  'switch_frame', 'context_menu', 'permission_grant', 'permission_deny',
  'set_geolocation', 'page_find', 'long_press',
  'service_worker_list', 'websocket_monitor',
];

export const mapImagePointToViewport = (point, imageSize, viewport) => {
  if (!Array.isArray(point) || point.length !== 2) return null;
  if (!Array.isArray(imageSize) || imageSize.length !== 2) return null;
  if (!Array.isArray(viewport) || viewport.length !== 2) return null;
  const [ix, iy] = point.map(Number);
  const [iw, ih] = imageSize.map(Number);
  const [vw, vh] = viewport.map(Number);
  if (![ix, iy, iw, ih, vw, vh].every(Number.isFinite) || iw <= 0 || ih <= 0 || vw <= 0 || vh <= 0) return null;
  return [
    Math.max(0, Math.min(vw - 1, Math.round(ix * vw / iw))),
    Math.max(0, Math.min(vh - 1, Math.round(iy * vh / ih))),
  ];
};

export const asPoint = (input, a = 'point', xKey = 'x', yKey = 'y') => {
  if (Array.isArray(input?.[a]) && input[a].length === 2) return input[a].map(Number);
  if (input?.[xKey] != null && input?.[yKey] != null) return [Number(input[xKey]), Number(input[yKey])];
  return null;
};

const isBlocked = (url = '') => url.startsWith('chrome://') || url.startsWith('chrome-extension://');

const currentPageTab = async (preferredTabId) => {
  if (preferredTabId) {
    const tab = await chrome.tabs.get(preferredTabId).catch(() => null);
    if (tab?.id && !isBlocked(tab.url)) return tab;
  }
  const win = await chrome.windows.getCurrent({windowTypes: ['normal']}).catch(() => null)
    || await chrome.windows.getLastFocused({windowTypes: ['normal']}).catch(() => null);
  if (win?.id) {
    const [tab] = await chrome.tabs.query({active: true, windowId: win.id});
    if (tab?.id) return tab;
  }
  return (await chrome.tabs.query({active: true, lastFocusedWindow: true}))[0]
    || (await chrome.tabs.query({active: true, currentWindow: true}))[0]
    || null;
};

const getTab = async (tabId) => {
  if (tabId) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    // 绑定的标签被关掉时给可行动的错误，可再调 bind_tab。
    return tab || {id: null, gone: true};
  }
  return await currentPageTab();
};

const waitTabComplete = (tabId) => new Promise((resolve) => {
  const finish = () => {
    chrome.tabs.onUpdated.removeListener(onUpdated);
    resolve();
  };
  const onUpdated = (id, info) => {
    if (id === tabId && info.status === 'complete') finish();
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.tabs.get(tabId).then((tab) => {
    if (tab.status === 'complete') finish();
  }).catch(finish);
  setTimeout(finish, 8000);
});

// 共用 CDP 连接；可能产生副作用的脚本不自动重试。
const attachedDebuggers = new Set();
const withDebugger = async (tabId, run, {retryDetached = true} = {}) => {
  const target = {tabId};
  if (!attachedDebuggers.has(tabId)) {
    await chrome.debugger.attach(target, '1.3');
    attachedDebuggers.add(tabId);
  }
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not attached|Detached|Debugger is not attached/i.test(message)) {
      attachedDebuggers.delete(tabId);
      if (!retryDetached) throw error;
      await chrome.debugger.attach(target, '1.3');
      attachedDebuggers.add(tabId);
      return run();
    }
    throw error;
  }
};
const cdpMouse = async (tabId, type, x, y, options = {}) => {
  const params = {
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: options.button || 'left',
    clickCount: options.clickCount || (type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0),
    ...options,
  };
  await withDebugger(tabId, () => chrome.debugger.sendCommand({tabId}, 'Input.dispatchMouseEvent', params));
};

// CDP 辅助函数：发送 Input.dispatchMouseEvent 序列（按下→移动→释放）
const cdpClick = async (tabId, x, y, options = {}) => {
  const {delay = 50} = options;
  await cdpMouse(tabId, 'mousePressed', x, y, {button: 'left', clickCount: 1});
  await new Promise((r) => setTimeout(r, delay));
  await cdpMouse(tabId, 'mouseReleased', x, y, {button: 'left', clickCount: 1});
};

// CDP 辅助函数：拖动序列（按下→多步移动→释放）
const cdpDrag = async (tabId, fromX, fromY, toX, toY, options = {}) => {
  const {steps = 12, stepDelay = 20} = options;
  await cdpMouse(tabId, 'mousePressed', fromX, fromY, {button: 'left', clickCount: 1, buttons: 1});
  for (let i = 1; i <= steps; i++) {
    const x = fromX + ((toX - fromX) * i / steps);
    const y = fromY + ((toY - fromY) * i / steps);
    await cdpMouse(tabId, 'mouseMoved', x, y, {button: 'left', buttons: 1});
    await new Promise((r) => setTimeout(r, stepDelay));
  }
  await cdpMouse(tabId, 'mouseReleased', toX, toY, {button: 'left', clickCount: 1, buttons: 0});
};

const waitNetworkIdle = async (tabId, quietMs = 500, maxMs = 8000) => {
  const tab = await getTab(tabId);
  if (!tab?.id) return {ok: false, error: '没有标签', requests: 0};
  const started = Date.now();
  let lastCount = -1;
  let quietSince = Date.now();
  let sample = [];
  while (Date.now() - started < maxMs) {
    let count = lastCount;
    try {
      const [{result}] = await chrome.scripting.executeScript({
        target: {tabId: tab.id},
        func: () => {
          const entries = performance.getEntriesByType('resource');
          return {
            count: entries.length,
            last: entries.slice(-8).map((item) => ({
              url: String(item.name || '').slice(0, 160),
              type: item.initiatorType,
              ms: Math.round(item.duration),
            })),
          };
        },
      });
      count = result?.count ?? 0;
      sample = result?.last || [];
    } catch {
      break;
    }
    if (count === lastCount) {
      if (Date.now() - quietSince >= quietMs) {
        return {ok: true, requests: count, quietMs, sample};
      }
    } else {
      lastCount = count;
      quietSince = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return {ok: false, error: '网络未安静', requests: Math.max(lastCount, 0), quietMs: 0, timedOut: true, sample};
};

const afterPageAction = async (tabId) => {
  const tab = await getTab(tabId);
  if (!tab?.id) return;
  await waitTabComplete(tab.id);
  await waitNetworkIdle(tab.id);
};

// 页面 JS 卡死时 executeScript 会无限挂起，服务端 30s 就判工具超时。
// 统一 8s 超时：宁可快速失败让模型换路，不挂到服务端上限。
const withTimeout = (promise, ms = 8000, what = '页内执行') => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}超时（页面可能卡死）`)), ms)),
]).catch((error) => {
  if (error instanceof Error && error.message.includes('超时')) return {ok: false, error: error.message};
  throw error;
});

const viewportOf = async (tabId) => {
  const tab = await getTab(tabId);
  if (!tab?.id || !tab.url || isBlocked(tab.url)) return null;
  try {
    const [{result}] = await withTimeout(chrome.scripting.executeScript({
      target: {tabId: tab.id},
      func: () => [window.innerWidth, window.innerHeight],
    }), 4000, '读视口');
    return Array.isArray(result) && result.length === 2 ? result : null;
  } catch {
    return null;
  }
};

const imageSizeOf = async (dataUrl) => {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const size = [bitmap.width, bitmap.height];
  bitmap.close();
  return size;
};

const inspectTab = async (tabId) => {
  const tab = await getTab(tabId);
  if (!tab?.id) {
    return {ok: false, error: tab?.gone ? '绑定的标签已被关闭，先重新 bind_tab' : '没有可读取的普通网页标签'};
  }
  if (!tab.url || isBlocked(tab.url)) return {ok: false, error: `当前页不可读取（${tab.url || '无 URL'}），换普通网页标签`};
  try {
    const [{result}] = await withTimeout(chrome.scripting.executeScript({
      target: {tabId: tab.id},
      func: () => ({
        title: document.title,
        url: location.href,
        text: document.body?.innerText?.slice(0, 4000) || '',
      }),
    }));
    return {ok: true, tab: tab.id, ...result};
  } catch (error) {
    return {ok: false, tab: tab.id, url: tab.url, title: tab.title, error: error instanceof Error ? error.message : String(error)};
  }
};

const runPageTool = async (name, input = {}) => {
  const tabId = input.tab ?? input.tabId;
  const tab = await inspectTab(tabId);
  if (!tab.ok) return tab;
  try {
    const [{result}] = await withTimeout(chrome.scripting.executeScript({
      target: {tabId: tab.tab},
      args: [name, {
        id: String(input.id || ''),
        regionId: String(input.regionId || ''),
        text: String(input.text ?? ''),
      }],
      func: (toolName, payload) => {
        const visible = (node) => {
          if (!(node instanceof Element)) return false;
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
          const rect = node.getBoundingClientRect();
          return rect.width >= 4 && rect.height >= 4;
        };
        const clip = (value, n = 80) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, n);
        const roleOf = (node) => node.getAttribute('role') || node.tagName.toLowerCase();
        const labelOf = (node) => {
          const explicit = node.id ? document.querySelector(`label[for="${CSS.escape(node.id)}"]`)?.innerText : '';
          return clip(explicit || node.closest('label')?.innerText || node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.getAttribute('title') || node.innerText || node.value || node.alt || node.name);
        };
        const regionRoots = [...document.querySelectorAll('header,nav,main,aside,footer,section,article,form,[role="banner"],[role="navigation"],[role="main"],[role="complementary"],[role="contentinfo"],[role="region"],[role="search"]')].filter(visible);
        const used = new Set();
        const regions = [];
        for (const node of regionRoots) {
          if ([...used].some((item) => item.contains(node) && item !== node)) continue;
          used.add(node);
          const rect = node.getBoundingClientRect();
          regions.push({
            id: `r${regions.length + 1}`,
            role: roleOf(node),
            tag: node.tagName.toLowerCase(),
            name: labelOf(node) || clip(node.innerText, 40),
            heading: clip((node.querySelector('h1,h2,h3,[role="heading"]') || {}).innerText, 60),
            rect: {x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height)},
            node,
          });
        }
        if (regions.length === 0 && document.body) {
          const rect = document.body.getBoundingClientRect();
          regions.push({id: 'r1', role: 'document', tag: 'body', name: clip(document.title, 40), heading: '', rect: {x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height)}, node: document.body});
        }
        const elements = [];
        for (const node of document.querySelectorAll('a[href],button,input:not([type=hidden]),textarea,select,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="textbox"],[contenteditable="true"],summary')) {
          if (!visible(node)) continue;
          const region = regions.find((item) => item.node.contains(node)) || regions[0];
          const rect = node.getBoundingClientRect();
          const inView = rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
          elements.push({
            id: `e${elements.length + 1}`,
            regionId: region?.id || 'r1',
            tag: node.tagName.toLowerCase(),
            role: roleOf(node),
            type: node.getAttribute('type') || '',
            name: labelOf(node),
            value: 'value' in node ? clip(node.value, 40) : '',
            href: node.href || '',
            disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true'),
            required: Boolean(node.required || node.getAttribute('aria-required') === 'true'),
            inView,
            rect: {x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height)},
            node,
          });
          if (elements.length >= 80) break;
        }
        const findRegion = (nid) => regions.find((item) => item.id === nid);
        const findElement = (nid) => elements.find((item) => item.id === nid);
        const strip = (item) => {
          const {node, ...rest} = item;
          return rest;
        };
        const axNode = (node, depth) => {
          if (!node || depth > 4) return null;
          const kids = [...node.children].filter(visible).slice(0, 12).map((child) => axNode(child, depth + 1)).filter(Boolean);
          return {role: roleOf(node), name: labelOf(node), tag: node.tagName.toLowerCase(), children: kids};
        };
        const id = payload.id;
        if (toolName === 'page.get_summary') {
          const headings = [...document.querySelectorAll('h1,h2,h3,[role="heading"]')].slice(0, 8)
            .map((node) => clip(node.innerText, 80)).filter(Boolean);
          return {
            ok: true,
            title: document.title,
            url: location.href,
            lang: document.documentElement.lang || '',
            regionCount: regions.length,
            interactiveCount: elements.length,
            headings,
            landmarkNames: regions.slice(0, 8).map((item) => `${item.id} ${item.role} ${item.name}`.trim()),
          };
        }
        if (toolName === 'page.list_regions') {
          return {
            ok: true,
            regions: regions.map((item) => ({
              id: item.id,
              role: item.role,
              name: item.name,
              heading: item.heading,
              interactiveCount: elements.filter((el) => el.regionId === item.id).length,
            })),
          };
        }
        if (toolName === 'page.list_interactive_elements') {
          const rid = payload.regionId || id;
          const rows = elements.filter((item) => !rid || item.regionId === rid || item.id === rid);
          return {
            ok: true,
            regionId: rid || null,
            elements: rows.map((item) => ({id: item.id, regionId: item.regionId, role: item.role, tag: item.tag, name: item.name, inView: item.inView, disabled: item.disabled})),
          };
        }
        if (toolName === 'page.inspect_region') {
          if (!id) return {ok: false, error: 'page.inspect_region 需要 id'};
          const region = findRegion(id);
          if (!region) return {ok: false, error: `没有区域 ${id}`};
          const kids = elements.filter((item) => item.regionId === id).slice(0, 20);
          return {
            ok: true,
            region: {id: region.id, role: region.role, name: region.name, heading: region.heading, rect: region.rect},
            elements: kids.map((item) => ({id: item.id, role: item.role, name: item.name, tag: item.tag})),
            text: clip(region.node.innerText, 400),
          };
        }
        if (toolName === 'page.inspect_element') {
          if (!id) return {ok: false, error: 'page.inspect_element 需要 id'};
          const el = findElement(id);
          if (!el) return {ok: false, error: `没有元素 ${id}`};
          return {ok: true, element: strip(el)};
        }
        if (toolName === 'page.get_dom') {
          if (!id) return {ok: false, error: 'page.get_dom 需要 id'};
          const hit = findElement(id) || findRegion(id);
          if (!hit) return {ok: false, error: `没有 ${id}`};
          const html = hit.node.outerHTML || '';
          return {ok: true, id, tag: hit.tag, html: html.slice(0, 4000), truncated: html.length > 4000};
        }
        if (toolName === 'page.get_accessibility_tree') {
          if (!id) return {ok: false, error: 'page.get_accessibility_tree 需要 id'};
          const hit = findElement(id) || findRegion(id);
          if (!hit) return {ok: false, error: `没有 ${id}`};
          return {ok: true, id, tree: axNode(hit.node, 0)};
        }
        if (toolName === 'page.get_element_state') {
          if (!id) return {ok: false, error: 'page.get_element_state 需要 id'};
          const el = findElement(id);
          if (!el) return {ok: false, error: `没有元素 ${id}`};
          const node = el.node;
          return {
            ok: true,
            id,
            focused: document.activeElement === node,
            disabled: el.disabled,
            required: el.required,
            checked: 'checked' in node ? Boolean(node.checked) : undefined,
            value: el.value,
            inView: el.inView,
            rect: el.rect,
          };
        }
        if (toolName === 'page.click') {
          if (!id) return {ok: false, error: 'page.click 需要 id'};
          const el = findElement(id);
          if (!el) return {ok: false, error: `没有元素 ${id}`};
          if (el.disabled) return {ok: false, error: `${id} 不可点`};
          el.node.click();
          return {ok: true, clicked: el.name || id, id};
        }
        if (toolName === 'page.type') {
          if (!id) return {ok: false, error: 'page.type 需要 id'};
          const el = findElement(id);
          if (!el) return {ok: false, error: `没有元素 ${id}`};
          const node = el.node;
          const value = payload.text;
          node.focus();
          if ('value' in node) {
            const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(node, value);
            else node.value = value;
          } else node.textContent = value;
          node.dispatchEvent(new Event('input', {bubbles: true}));
          node.dispatchEvent(new Event('change', {bubbles: true}));
          return {ok: true, id, value: 'value' in node ? node.value : node.textContent};
        }
        return {ok: false, error: `${toolName} 未接`};
      },
    }));
    const out = {tab: tab.tab, title: tab.title, url: tab.url, ...result};
    if (out.ok && (name === 'page.click' || name === 'page.type')) await afterPageAction(tabId);
    return out;
  } catch (error) {
    return {ok: false, tab: tab.tab, error: error instanceof Error ? error.message : String(error)};
  }
};

const runOnTab = async (tabId, args, func) => {
  const tab = await inspectTab(tabId);
  if (!tab.ok) return tab;
  try {
    const [{result}] = await withTimeout(chrome.scripting.executeScript({
      target: {tabId: tab.tab},
      args,
      func,
    }));
    return {tab: tab.tab, title: tab.title, url: tab.url, ...result};
  } catch (error) {
    return {ok: false, tab: tab.tab, error: error instanceof Error ? error.message : String(error)};
  }
};

export const runBrowserTool = async (name, input = {}) => {
  const tabId = input.tab ?? input.tabId;
  if (name.startsWith('page.')) return runPageTool(name, input);
  if (name === 'see_page' || name === 'watch_page') return inspectTab(tabId);
  if (name === 'snapshot_page' || name === 'find_on_page') {
    const page = await inspectTab(tabId);
    if (!page.ok) return page;
    const snap = await runOnTab(page.tab, [input.text || ''], (q) => {
      const nodes = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')];
      const labelOf = (node) => {
        const explicit = node.id ? document.querySelector(`label[for="${CSS.escape(node.id)}"]`)?.innerText : '';
        return (explicit || node.closest('label')?.innerText || '').trim().slice(0, 100);
      };
      const rows = nodes.slice(0, 40).map((node, index) => {
        const rect = node.getBoundingClientRect();
        return {
          ref: `el-${index}`,
          tag: node.tagName.toLowerCase(),
          role: node.getAttribute('role') || '',
          type: node.getAttribute('type') || '',
          name: node.getAttribute('name') || '',
          text: (node.innerText || node.getAttribute('aria-label') || '').trim().slice(0, 100),
          placeholder: node.getAttribute('placeholder') || '',
          label: labelOf(node),
          value: 'value' in node ? String(node.value || '').slice(0, 100) : '',
          checked: 'checked' in node ? Boolean(node.checked) : undefined,
          disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true'),
          required: Boolean(node.required || node.getAttribute('aria-required') === 'true'),
          href: node.href || '',
          rect: {x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height)},
        };
      });
      const dialog = document.querySelector('[role="dialog"],dialog,[aria-modal="true"]');
      const pageState = document.readyState !== 'complete'
        ? 'loading'
        : dialog
          ? 'dialog'
          : 'ready';
      const headings = [...document.querySelectorAll('h1,h2,h3,[role="heading"]')].slice(0, 12)
        .map((node) => ({level: Number(node.getAttribute('aria-level')) || Number(node.tagName.slice(1)) || null, text: node.innerText.trim().slice(0, 120)}))
        .filter((item) => item.text);
      const landmarks = [...document.querySelectorAll('header,nav,main,aside,footer,[role="banner"],[role="navigation"],[role="main"],[role="complementary"],[role="contentinfo"]')]
        .slice(0, 12).map((node) => ({role: node.getAttribute('role') || node.tagName.toLowerCase(), text: node.innerText.trim().slice(0, 160)}));
      const forms = [...document.forms].slice(0, 8).map((form, index) => ({
        index,
        name: form.name || form.id || '',
        action: form.action || '',
        method: form.method || 'get',
        fields: [...form.querySelectorAll('input:not([type=hidden]),textarea,select')].slice(0, 20).map((field) => ({
          type: field.type || field.tagName.toLowerCase(), name: field.name || '', label: labelOf(field), placeholder: field.placeholder || '', required: Boolean(field.required), disabled: Boolean(field.disabled),
        })),
      }));
      const filtered = q ? rows.filter((item) => [item.text, item.label, item.placeholder, item.name, item.href].some((value) => String(value).includes(q))) : rows;
      return {ok: true, page_state: pageState, headings, landmarks, forms, elements: filtered};
    });
    return {...page, ...snap};
  }
  if (name === 'see_page_info') {
    return runOnTab(tabId, [], () => ({
      ok: true,
      title: document.title,
      url: location.href,
      description: document.querySelector('meta[name="description"]')?.content || '',
    }));
  }
  if (name === 'extract_table') {
    return runOnTab(tabId, [], () => ({
      ok: true,
      tables: [...document.querySelectorAll('table')].slice(0, 5).map((table) =>
        [...table.rows].slice(0, 20).map((row) => [...row.cells].map((cell) => cell.innerText.trim().slice(0, 80)))),
      lists: [...document.querySelectorAll('ul,ol')].slice(0, 8).map((list) =>
        [...list.querySelectorAll(':scope > li')].slice(0, 20).map((item) => item.innerText.trim().slice(0, 80))),
    }));
  }
  if (name === 'check_page') {
    const page = await inspectTab(tabId);
    if (!page.ok) return page;
    const needle = input.text || input.url || input.title || '';
    const hit = [page.title, page.url, page.text].join('\n');
    return {ok: !needle || hit.includes(needle), tabId: page.tab, title: page.title, url: page.url, matched: needle};
  }
  if (name === 'click' || name === 'double_click' || name === 'focus' || name === 'hover') {
    const result = await runOnTab(tabId, [input.ref || '', input.text || '', name], (ref, q, action) => {
      const nodes = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')];
      const refIndex = /^el-(\d+)$/.exec(ref)?.[1];
      const hit = refIndex !== undefined
        ? nodes[Number(refIndex)]
        : nodes.find((node) => (node.innerText || node.value || node.getAttribute('aria-label') || '').includes(q));
      if (!hit) return {ok: false, error: '没找到可点元素'};
      if (action === 'double_click') hit.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));
      else if (action === 'focus') hit.focus();
      else if (action === 'hover') hit.dispatchEvent(new MouseEvent('mouseover', {bubbles: true}));
      else hit.click();
      return {ok: true, clicked: (hit.innerText || hit.value || '').slice(0, 80)};
    });
    if (result.ok && name !== 'hover' && name !== 'focus') await afterPageAction(tabId);
    return result;
  }
  if (name === 'type') {
    const result = await runOnTab(tabId, [input.text || '', input.ref || '', input.target || ''], (value, ref, q) => {
      const nodes = [...document.querySelectorAll('input:not([type=hidden]),textarea,[contenteditable="true"]')];
      const labelText = (node) => {
        const id = node.id;
        const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        return [node.name, node.placeholder, node.getAttribute('aria-label'), label?.innerText].filter(Boolean).join(' ');
      };
      const allInteractive = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')];
      const refIndex = /^el-(\d+)$/.exec(ref)?.[1];
      const byRef = refIndex !== undefined ? allInteractive[Number(refIndex)] : null;
      const el = byRef && nodes.includes(byRef)
        ? byRef
        : (q ? nodes.find((node) => labelText(node).toLowerCase().includes(q.toLowerCase())) : null);
      if (!el) return {ok: false, error: '没找到输入框'};
      el.focus();
      if ('value' in el) {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, value);
        else el.value = value;
      } else el.textContent = value;
      el.dispatchEvent(new Event('input', {bubbles: true}));
      el.dispatchEvent(new Event('change', {bubbles: true}));
      return {ok: true, value: 'value' in el ? el.value : el.textContent};
    });
    if (result.ok) await afterPageAction(tabId);
    return result;
  }
  if (name === 'tick') {
    const result = await runOnTab(tabId, [input.text || '', input.checked !== false], (q, checked) => {
      const nodes = [...document.querySelectorAll('input[type=checkbox],input[type=radio]')];
      const el = q
        ? nodes.find((node) => (node.innerText || node.value || node.name || node.getAttribute('aria-label') || '').includes(q))
        : null;
      if (!el) return {ok: false, error: q ? '没找到匹配选项' : 'tick 需要 text'};
      el.checked = checked;
      el.dispatchEvent(new Event('change', {bubbles: true}));
      return {ok: true};
    });
    if (result.ok) await afterPageAction(tabId);
    return result;
  }
  if (name === 'select') {
    const result = await runOnTab(tabId, [input.value || input.text || ''], (value) => {
      const el = document.querySelector('select');
      if (!el) return {ok: false, error: '没找到下拉框'};
      const option = [...el.options].find((item) => item.text.includes(value) || item.value === value);
      if (!option) return {ok: false, error: '没找到匹配选项'};
      el.value = option.value;
      el.dispatchEvent(new Event('change', {bubbles: true}));
      return {ok: true, value: el.value};
    });
    if (result.ok) await afterPageAction(tabId);
    return result;
  }
  if (name === 'submit') {
    const result = await runOnTab(tabId, [], () => {
      const form = document.querySelector('form');
      if (!form) return {ok: false, error: '没找到表单'};
      if (form.requestSubmit) form.requestSubmit();
      else form.submit();
      return {ok: true};
    });
    if (result.ok) await afterPageAction(tabId);
    return result;
  }
  if (name === 'press') {
    const result = await runOnTab(tabId, [input.key || 'Enter'], (key) => {
      const el = document.activeElement;
      if (!el || el === document.body) return {ok: false, error: '没有焦点元素'};
      el.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true}));
      return {ok: true, key};
    });
    if (result.ok) await afterPageAction(tabId);
    return result;
  }
  if (name === 'scroll') {
    return runOnTab(tabId, [input.amount || 600], (amount) => {
      window.scrollBy(0, amount);
      return {ok: true};
    });
  }
  if (name === 'scroll_to') {
    return runOnTab(tabId, [input.text || ''], (q) => {
      const nodes = [...document.querySelectorAll('a,button,input,h1,h2,p')];
      const el = nodes.find((node) => (node.innerText || '').includes(q));
      if (!el) return {ok: false, error: q ? '没找到匹配元素' : 'scroll_to 需要 text'};
      el.scrollIntoView({block: 'center'});
      return {ok: true};
    });
  }
  if (name === 'wait') {
    if (input.text) {
      // 服务端 30s 就判工具超时：等待窗口压到 12s，给 inspect 留余量。
      const deadline = Date.now() + Math.min(Number(input.ms) || 8000, 12000);
      let page = await inspectTab(tabId);
      while (Date.now() < deadline && !(page.text || '').includes(input.text)) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        page = await inspectTab(tabId);
      }
      return page.ok && (page.text || '').includes(input.text) ? page : {...page, ok: false, error: page.error || '没等到这段文字'};
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(Number(input.ms) || 800, 8000)));
    return inspectTab(tabId);
  }
  if (name === 'wait_network') {
    const idle = await waitNetworkIdle(tabId, Number(input.ms) || 500);
    const page = await inspectTab(tabId);
    return {...page, ...idle, ok: page.ok !== false && idle.ok !== false};
  }
  if (name === 'click_xy') {
    const point = asPoint(input);
    if (!point) return {ok: false, error: '缺 point=[x,y]（也可传 x、y）'};
    const [x, y] = point;
    const tab = await getTab(tabId);
    if (!tab?.id) return {ok: false, error: '没有标签'};
    try {
      await cdpClick(tab.id, x, y);
      await afterPageAction(tab.id);
      return {ok: true, point: [x, y], trusted: true};
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {ok: false, error: `CDP click 失败：${message}`};
    }
  }
  if (name === 'drag') {
    const point1 = asPoint(input, 'point1', 'x1', 'y1') || asPoint(input, 'from');
    const point2 = asPoint(input, 'point2', 'x2', 'y2') || asPoint(input, 'to');
    if (!point1 || !point2) return {ok: false, error: '缺 point1=[x,y] 或 point2=[x,y]（也可传 x1/y1、x2/y2）'};
    const [x1, y1] = point1;
    const [x2, y2] = point2;
    const tab = await getTab(tabId);
    if (!tab?.id) return {ok: false, error: '没有标签'};
    try {
      await cdpDrag(tab.id, x1, y1, x2, y2);
      await afterPageAction(tab.id);
      return {ok: true, from: [x1, y1], to: [x2, y2], trusted: true};
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {ok: false, error: `CDP drag 失败：${message}`};
    }
  }
  if (name === 'calibrate_drag') {
    const point1 = asPoint(input, 'point1', 'x1', 'y1');
    const point2 = asPoint(input, 'point2', 'x2', 'y2');
    if (!point1 || !point2) return {ok: false, error: '缺 point1=[x,y] 或 point2=[x,y]（截图像素坐标）'};
    const imageSize = input.image_size;
    const viewport = input.viewport || await viewportOf(tabId);
    if (!Array.isArray(imageSize) || imageSize.length !== 2) {
      return {ok: false, error: '缺 image_size=[宽,高]（用最近一次 screenshot 返回值）'};
    }
    if (!Array.isArray(viewport) || viewport.length !== 2) {
      return {ok: false, error: '缺 viewport=[宽,高]（用最近一次 screenshot 返回值）'};
    }
    const from = mapImagePointToViewport(point1, imageSize, viewport);
    const to = mapImagePointToViewport(point2, imageSize, viewport);
    if (!from || !to) return {ok: false, error: '截图坐标无法映射到视口'};
    const dragged = await runBrowserTool('drag', {point1: from, point2: to, ...(tabId ? {tab: tabId} : {})});
    return {
      ...dragged,
      image_point1: input.point1,
      image_point2: input.point2,
      image_size: imageSize,
      viewport,
      mapped_from: from,
      mapped_to: to,
    };
  }
  if (name === 'clipboard') {
    // service worker 里没有 navigator.clipboard，走 offscreen 不值得；
    // 直接如实报错，让 Task 换路（如页内 execute_javascript 写剪贴板）。
    return {ok: false, error: '后台环境不能读写系统剪贴板；可在页面里用 execute_javascript 调 navigator.clipboard'};
  }
  if (name === 'attach_file') return {ok: false, error: '没有已附加文件'};
  if (name === 'clear_file') {
    const tab = await getTab(tabId);
    if (!tab?.id) return {ok: false, error: '没有标签'};
    return runOnTab(tabId, [], () => {
      const inputs = document.querySelectorAll('input[type=file]');
      inputs.forEach((input) => { input.value = ''; });
      return {ok: true, cleared: inputs.length};
    });
  }
  if (name === 'open_url') {
    const tab = await getTab(tabId);
    if (!tab?.id) return {ok: false, error: '没有标签'};
    if (!input.url) return {ok: false, error: '缺 url'};
    await chrome.tabs.update(tab.id, {url: input.url});
    await waitTabComplete(tab.id);
    await waitNetworkIdle(tab.id);
    return inspectTab(tab.id);
  }
  if (name === 'reload') {
    const tab = await getTab(tabId);
    if (!tab?.id) return {ok: false, error: '没有标签'};
    await chrome.tabs.reload(tab.id);
    await waitTabComplete(tab.id);
    await waitNetworkIdle(tab.id);
    return inspectTab(tab.id);
  }
  if (name === 'go_history') {
    const tab = await getTab(tabId);
    const result = await runOnTab(tabId, [input.action || 'back'], (action) => {
      if (action === 'forward') history.forward();
      else history.back();
      return {ok: true, action};
    });
    if (result.ok && tab?.id) {
      await waitTabComplete(tab.id);
      await waitNetworkIdle(tab.id);
      return inspectTab(tab.id);
    }
    return result;
  }
  if (name === 'bind_tab') {
    const tab = await currentPageTab(input.tab);
    if (!tab?.id || !tab.url || isBlocked(tab.url)) return {ok: false, error: '没有可绑定的普通网页标签'};
    return {ok: true, tab: tab.id, tabId: tab.id, url: tab.url, title: tab.title};
  }
  if (name === 'see_env') {
    const [tabs, windows, current] = await Promise.all([
      chrome.tabs.query({}),
      chrome.windows.getAll(),
      currentPageTab(input.tab),
    ]);
    const normal = tabs.filter((item) => !isBlocked(item.url));
    const ranked = current?.windowId
      ? [...normal.filter((item) => item.windowId === current.windowId), ...normal.filter((item) => item.windowId !== current.windowId)]
      : normal;
    const brief = (item) => ({
      id: item.id,
      title: String(item.title || '').slice(0, 80),
      url: String(item.url || '').slice(0, 160),
      active: item.id === current?.id,
    });
    return {
      ok: true,
      activeTab: current ? {id: current.id, url: current.url, title: current.title, blocked: isBlocked(current.url)} : null,
      windowCount: windows.length,
      tabCount: tabs.length,
      tabs: ranked.slice(0, 10).map(brief),
      truncated: Math.max(ranked.length - 10, 0),
    };
  }
  if (name === 'list_tabs') {
    const tabs = await chrome.tabs.query({currentWindow: true});
    return {ok: true, tabs: tabs.map((tab) => ({id: tab.id, title: tab.title, url: tab.url}))};
  }
  if (name === 'list_windows') {
    const windows = await chrome.windows.getAll();
    return {ok: true, windows: windows.map((item) => ({id: item.id, focused: item.focused, type: item.type}))};
  }
  if (name === 'switch_tab') {
    const tab = input.tab ?? input.tabId;
    if (!tab) return {ok: false, error: '缺 tab'};
    await chrome.tabs.update(tab, {active: true});
    return inspectTab(tab);
  }
  if (name === 'open_tab') {
    const tab = await chrome.tabs.create({url: input.url || 'about:blank'});
    return {ok: true, tabId: tab.id, url: tab.url, title: tab.title};
  }
  if (name === 'close_tab') {
    const tab = await getTab(tabId);
    if (!tab?.id) return {ok: false, error: '没有标签'};
    await chrome.tabs.remove(tab.id);
    return {ok: true};
  }
  if (name === 'duplicate_tab') {
    const tab = await getTab(tabId);
    if (!tab?.id) return {ok: false, error: '没有标签'};
    const copy = await chrome.tabs.duplicate(tab.id);
    return {ok: true, tabId: copy.id};
  }
  if (name === 'move_tab') {
    const tab = await getTab(tabId);
    if (!tab?.id) return {ok: false, error: '没有标签'};
    await chrome.tabs.move(tab.id, {index: input.index ?? -1});
    return {ok: true};
  }
  if (name === 'update_tab') {
    const tab = await getTab(tabId);
    if (!tab?.id) return {ok: false, error: '没有标签'};
    await chrome.tabs.update(tab.id, {pinned: input.pinned, muted: input.muted});
    return {ok: true};
  }
  if (name === 'create_window') {
    const win = await chrome.windows.create({url: input.url});
    return {ok: true, windowId: win.id};
  }
  if (name === 'update_window') {
    const win = await chrome.windows.getCurrent();
    await chrome.windows.update(win.id, {state: input.state || 'normal'});
    return {ok: true};
  }
  if (name === 'close_window') {
    const win = await chrome.windows.getCurrent();
    await chrome.windows.remove(win.id);
    return {ok: true};
  }
  if (name === 'group_tabs') {
    const id = await chrome.tabs.group({tabIds: input.tabIds || [tabId].filter(Boolean)});
    return {ok: true, groupId: id};
  }
  if (name === 'ungroup_tabs') {
    await chrome.tabs.ungroup(input.tabIds || [tabId].filter(Boolean));
    return {ok: true};
  }
  if (name === 'screenshot_full' || name === 'screenshot_one') {
    const tab = await getTab(tabId);
    if (!tab?.id) return {ok: false, error: '没有标签'};
    try {
      // captureVisibleTab 只截窗口的活动标签，先恢复窗口并激活目标页。
      if (tab.windowId) {
        await chrome.windows.update(tab.windowId, {state: 'normal', focused: true}).catch(() => {});
      }
      await chrome.tabs.update(tab.id, {active: true});
      await waitNetworkIdle(tab.id);
      if (name === 'screenshot_one') {
        // 元素截图：先获取元素位置，然后裁剪
        const {ref} = input;
        if (!ref) return {ok: false, error: 'screenshot_one 需要 ref 参数'};
        const [{result}] = await chrome.scripting.executeScript({
          target: {tabId: tab.id},
          func: (r) => {
            const el = document.querySelector(`[data-ref="${r}"]`) || document.querySelector(r);
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
          },
          args: [ref],
        });
        if (!result) return {ok: false, error: `未找到元素 ref=${ref}`};
        // 使用CDP截图并裁剪
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {format: 'jpeg', quality: 70});
        // 简单返回全图，标注元素位置（完整裁剪需要offscreen document）
        return {ok: true, tab: tab.id, image: dataUrl, mime: 'image/jpeg', element_rect: result};
      }
      // 整页截图：滚动到底部再截
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {format: 'jpeg', quality: 70});
      return {ok: true, tab: tab.id, image: dataUrl, mime: 'image/jpeg'};
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {ok: false, error: `截图失败：${message}`};
    }
  }
  if (name === 'screenshot') {
    const tab = await getTab(tabId);
    if (!tab?.id || !tab.url || isBlocked(tab.url)) return {ok: false, error: '没有可截图的普通网页标签'};
    // 最小化的窗口 Chrome 会挂起渲染器，captureVisibleTab 必报
    // "image readback failed"。先恢复窗口再激活标签。
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, {state: 'normal', focused: true}).catch(() => {});
    }
    await chrome.tabs.update(tab.id, {active: true});
    await waitNetworkIdle(tab.id);
    const shotMeta = async (image) => ({
      ok: true,
      tab: tab.id,
      image,
      mime: 'image/jpeg',
      image_size: await imageSizeOf(image),
      viewport: await viewportOf(tab.id),
    });
    try {
      return await shotMeta(await chrome.tabs.captureVisibleTab(tab.windowId, {format: 'jpeg', quality: 70}));
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      try {
        return await shotMeta(await chrome.tabs.captureVisibleTab(tab.windowId, {format: 'jpeg', quality: 70}));
      } catch (retryError) {
        return {ok: false, error: retryError instanceof Error ? retryError.message : String(retryError)};
      }
    }
  }
  if (name === 'save_pdf') return {ok: false, error: '当前环境不能存 PDF'};
  if (name === 'download') {
    if (!input.url) return {ok: false, error: '缺 url'};
    const id = await chrome.downloads.download({url: input.url});
    return {ok: true, downloadId: id};
  }
  if (name === 'wait_download' || name === 'list_downloads') {
    const items = await chrome.downloads.search({limit: 10, orderBy: ['-startTime']});
    return {ok: true, downloads: items.map((item) => ({id: item.id, filename: item.filename, state: item.state}))};
  }
  if (name === 'control_download') {
    if (!input.downloadId) return {ok: false, error: '缺 downloadId'};
    if (input.action === 'pause') await chrome.downloads.pause(input.downloadId);
    else if (input.action === 'cancel') await chrome.downloads.cancel(input.downloadId);
    else await chrome.downloads.resume(input.downloadId);
    return {ok: true};
  }
  if (name === 'export_data') {
    // 通过downloads API下载数据
    const {data, filename} = input;
    if (!data) return {ok: false, error: '缺 data'};
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    // MV3 Service Worker 不提供 createObjectURL；data URL 可直接交给下载 API。
    const url = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
    const id = await chrome.downloads.download({url, filename: filename || 'export.txt'});
    return {ok: true, downloadId: id};
  }
  if (name === 'cookies') {
    const tab = await getTab(tabId);
    const url = input.url || tab?.url;
    if (!url) return {ok: false, error: '缺 url'};
    const cookies = await chrome.cookies.getAll({url});
    return {ok: true, cookies: cookies.map((item) => ({name: item.name, value: item.value, domain: item.domain}))};
  }
  if (name === 'read_page_credentials') {
    return runOnTab(tabId, [], () => ({
      ok: true,
      fields: [...document.querySelectorAll('input[type=password],input[type=email]')].map((el) => ({
        name: el.name || el.type,
        value: el.value ? '[set]' : '',
      })),
    }));
  }
  if (name === 'indexeddb') {
    const {action, db, store, key, value} = input;
    if (!db) return {ok: false, error: '缺 db (数据库名)'};
    return runOnTab(tabId, [action || 'read', db, store || '', key || '', value || ''], async (act, dbName, storeName, k, v) => {
      return new Promise((resolve) => {
        const request = indexedDB.open(dbName);
        request.onerror = () => resolve({ok: false, error: request.error?.message || '打开失败'});
        request.onsuccess = (event) => {
          const database = event.target.result;
          if (!storeName) {
            // 列出所有object store
            const stores = Array.from(database.objectStoreNames);
            database.close();
            return resolve({ok: true, stores});
          }
          try {
            const tx = database.transaction(storeName, act === 'write' || act === 'delete' ? 'readwrite' : 'readonly');
            const store = tx.objectStore(storeName);
            if (act === 'read' && k) {
              const req = store.get(k);
              req.onsuccess = () => { database.close(); resolve({ok: true, value: req.result}); };
              req.onerror = () => { database.close(); resolve({ok: false, error: req.error?.message}); };
            } else if (act === 'write' && k) {
              const req = store.put(v ? JSON.parse(v) : null, k);
              req.onsuccess = () => { database.close(); resolve({ok: true}); };
              req.onerror = () => { database.close(); resolve({ok: false, error: req.error?.message}); };
            } else if (act === 'delete' && k) {
              const req = store.delete(k);
              req.onsuccess = () => { database.close(); resolve({ok: true}); };
              req.onerror = () => { database.close(); resolve({ok: false, error: req.error?.message}); };
            } else {
              // 列出所有key
              const req = store.getAllKeys();
              req.onsuccess = () => { database.close(); resolve({ok: true, keys: req.result}); };
              req.onerror = () => { database.close(); resolve({ok: false, error: req.error?.message}); };
            }
          } catch (e) {
            database.close();
            resolve({ok: false, error: e.message});
          }
        };
        request.onupgradeneeded = () => resolve({ok: true, created: true});
      });
    });
  }
  if (name === 'cache_storage') {
    const {action, cache, key, value} = input;
    if (!cache) return {ok: false, error: '缺 cache (缓存名)'};
    return runOnTab(tabId, [action || 'read', cache, key || '', value || ''], async (act, cacheName, k, v) => {
      try {
        if (act === 'list') {
          const caches = await window.caches.keys();
          return {ok: true, caches};
        }
        const cacheObj = await window.caches.open(cacheName);
        if (act === 'read' && k) {
          const response = await cacheObj.match(k);
          const text = response ? await response.text() : null;
          return {ok: true, value: text};
        } else if (act === 'write' && k && v) {
          await cacheObj.put(k, new Response(v));
          return {ok: true};
        } else if (act === 'delete' && k) {
          await cacheObj.delete(k);
          return {ok: true};
        } else {
          const keys = await cacheObj.keys();
          return {ok: true, keys: keys.map((r) => r.url)};
        }
      } catch (e) {
        return {ok: false, error: e.message};
      }
    });
  }
  if (name === 'page_storage') {
    return runOnTab(tabId, [input.action || 'read', input.key || '', input.value || ''], (action, key, value) => {
      if (action === 'write' && key) {
        localStorage.setItem(key, value);
        return {ok: true};
      }
      if (action === 'delete' && key) {
        localStorage.removeItem(key);
        return {ok: true};
      }
      return {ok: true, storage: Object.fromEntries(Object.entries(localStorage).slice(0, 20))};
    });
  }
  if (name === 'capture_network_traffic') {
    return runOnTab(tabId, [], () => {
      const items = performance.getEntriesByType('resource').slice(-30).map((item) => ({
        url: String(item.name || '').slice(0, 200),
        type: item.initiatorType,
        ms: Math.round(item.duration),
        bytes: Math.round(item.transferSize || 0),
      }));
      return {ok: true, count: items.length, items};
    });
  }
  if (name === 'profile_vault') {
    // profile_vault 通过 chrome.storage 存储配置，manifest 必须声明 storage 权限。
    const {action, profileId, data} = input;
    if (action === 'save' && profileId && data) {
      const storage = await chrome.storage.local.get('profiles');
      const profiles = storage.profiles || {};
      profiles[profileId] = {...data, updatedAt: Date.now()};
      await chrome.storage.local.set({profiles});
      return {ok: true, saved: profileId};
    }
    if (action === 'get' && profileId) {
      const storage = await chrome.storage.local.get('profiles');
      const profile = (storage.profiles || {})[profileId];
      return profile ? {ok: true, profile} : {ok: false, error: `未找到 profile ${profileId}`};
    }
    // 默认列出所有 profiles
    const storage = await chrome.storage.local.get('profiles');
    const profiles = storage.profiles || {};
    return {ok: true, items: Object.entries(profiles).map(([id, p]) => ({id, ...p}))};
  }
  if (name === 'execute_javascript') {
    if (typeof input.code !== 'string' || !input.code.trim()) return {ok: false, error: '缺 code'};
    const limit = 16000;
    try {
      const tab = await getTab(tabId);
      if (!tab?.id || isBlocked(tab.url)) return {ok: false, error: '没有可执行脚本的普通网页标签'};
      const response = await withDebugger(tab.id, async () => {
        let timer;
        try {
          return await Promise.race([
            chrome.debugger.sendCommand({tabId: tab.id}, 'Runtime.evaluate', {
              expression: input.code,
              awaitPromise: true,
              returnByValue: true,
              timeout: 5000,
              allowUnsafeEvalBlockedByCSP: true,
            }),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('等待 JavaScript 结果超时；执行状态未知，脚本可能仍在继续，请先检查页面状态，勿直接重复执行。')), 8000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }, {retryDetached: false});
      if (response?.exceptionDetails) {
        const details = response.exceptionDetails;
        const error = String(details.exception?.description || details.text || 'JavaScript 执行失败');
        return {ok: false, tab: tab.id, error: error.slice(0, limit), ...(error.length > limit ? {truncated: true} : {})};
      }
      const remote = response?.result;
      if (!remote?.type) return {ok: false, tab: tab.id, error: '执行器未返回 JavaScript 结果'};
      const result = {ok: true, tab: tab.id, type: remote.type};
      if (Object.hasOwn(remote, 'value')) {
        const serialized = JSON.stringify(remote.value);
        if (serialized.length > limit) {
          return {...result, truncated: true, totalChars: serialized.length, valuePreview: serialized.slice(0, limit)};
        }
        return {...result, value: remote.value};
      }
      if (remote.unserializableValue != null) {
        const value = String(remote.unserializableValue);
        return value.length > limit
          ? {...result, truncated: true, totalChars: value.length, valuePreview: value.slice(0, limit)}
          : {...result, unserializableValue: value};
      }
      if (remote.type === 'undefined') return result;
      const description = String(remote.description || remote.subtype || remote.type);
      return {...result, serializable: false, description: description.slice(0, limit), ...(description.length > limit ? {truncated: true} : {})};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {ok: false, error: message.slice(0, limit), ...(message.length > limit ? {truncated: true} : {})};
    }
  }
  if (name === 'handle_dialog') {
    // handle_dialog 需要在页面加载前设置监听，这里返回提示
    return {ok: false, error: 'handle_dialog 需要在页面加载前设置；对于已有弹窗，请在新页面使用 wait_dialog 或手动处理'};
  }
  if (name === 'see_zoom') {
    const tab = await getTab(tabId);
    return {ok: true, zoom: tab?.id ? await chrome.tabs.getZoom(tab.id) : 1};
  }
  if (name === 'set_zoom') {
    const tab = await getTab(tabId);
    if (!tab?.id) return {ok: false, error: '没有标签'};
    await chrome.tabs.setZoom(tab.id, input.zoom || 1);
    return {ok: true};
  }
  if (name === 'see_diag') return inspectTab(tabId);
  if (name === 'see_console') {
    const tab = await getTab(tabId);
    if (!tab?.id || !tab.url || isBlocked(tab.url)) return {ok: false, error: '没有可读取的普通网页标签'};
    await chrome.scripting.executeScript({
      target: {tabId: tab.id},
      world: 'MAIN',
      files: ['content-console.js'],
    }).catch(() => {});
    try {
      const [{result}] = await withTimeout(chrome.scripting.executeScript({
        target: {tabId: tab.id},
        world: 'MAIN',
        func: (want) => {
          const all = globalThis.__telanceConsole || [];
          const items = want && want !== 'all' ? all.filter((item) => item.level === want) : all;
          return {ok: true, count: items.length, items: items.slice(-50)};
        },
        args: [input.level || 'error'],
      }));
      return {ok: true, tab: tab.id, ...(result || {count: 0, items: []})};
    } catch (error) {
      return {ok: false, tab: tab.id, error: error instanceof Error ? error.message : String(error)};
    }
  }
  if (name === 'wait_popup') {
    const {timeoutMs} = input;
    const timeout = Math.min(Number(timeoutMs) || 3000, 5000);
    const before = new Set((await chrome.tabs.query({currentWindow: true})).map((t) => t.id));
    return new Promise((resolve) => {
      const onCreated = (tab) => {
        chrome.tabs.onCreated.removeListener(onCreated);
        clearTimeout(timer);
        resolve({ok: true, tab: {id: tab.id, url: tab.url, title: tab.title}});
      };
      const timer = setTimeout(() => {
        chrome.tabs.onCreated.removeListener(onCreated);
        resolve({ok: false, error: '超时没有新弹窗'});
      }, timeout);
      chrome.tabs.onCreated.addListener(onCreated);
    });
  }
  if (name === 'list_browser_tools') {
    return {ok: true, tools: BROWSER_TOOL_NAMES};
  }
  if (name === 'measure_timing' || name === 'measure_paint' || name === 'measure_files') {
    return runOnTab(tabId, [name], (kind) => {
      const nav = performance.getEntriesByType('navigation')[0];
      if (kind === 'measure_timing') {
        return {
          ok: true,
          url: location.href,
          ttfbMs: nav ? Math.round(nav.responseStart) : null,
          domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
          loadMs: nav ? Math.round(nav.loadEventEnd) : null,
        };
      }
      if (kind === 'measure_paint') {
        const paints = Object.fromEntries(performance.getEntriesByType('paint').map((item) => [item.name, Math.round(item.startTime)]));
        const lcp = performance.getEntriesByType('largest-contentful-paint').at(-1);
        return {
          ok: true,
          firstPaintMs: paints['first-paint'] ?? null,
          firstContentfulPaintMs: paints['first-contentful-paint'] ?? null,
          largestContentfulPaintMs: lcp ? Math.round(lcp.startTime) : null,
        };
      }
      const resources = performance.getEntriesByType('resource');
      const items = resources.slice(0, 30).map((item) => ({
        name: String(item.name).slice(0, 160),
        durationMs: Math.round(item.duration),
        transferBytes: Math.round(item.transferSize || 0),
      }));
      return {
        ok: true,
        count: resources.length,
        transferBytes: items.reduce((sum, item) => sum + item.transferBytes, 0),
        items,
      };
    });
  }
  if (name === 'see_captcha' || name === 'wait_captcha' || name === 'click_captcha' || name === 'solve_captcha') {
    const inspect = () => runOnTab(tabId, [], () => {
      const frames = [...document.querySelectorAll('iframe')].map((node) => node.src || '');
      const type = frames.some((src) => src.includes('challenges.cloudflare.com') || src.includes('turnstile'))
        ? 'turnstile'
        : frames.some((src) => src.includes('recaptcha'))
          ? 'recaptcha'
          : frames.some((src) => src.includes('hcaptcha'))
            ? 'hcaptcha'
            : document.querySelector('[name=cf-turnstile-response],input[name=h-captcha-response],textarea[name=g-recaptcha-response]')
              ? 'token'
              : null;
      return {ok: true, present: Boolean(type), type, ready: Boolean(type)};
    });
    if (name === 'wait_captcha') {
      // 服务端 30s 上限：等待窗口压到 12s。
      const deadline = Date.now() + Math.min(Number(input.timeoutMs) || 8000, 12000);
      let last = await inspect();
      while (!last.present && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        last = await inspect();
      }
      return last.present ? last : {ok: false, error: '没等到验证码', ...last};
    }
    const found = await inspect();
    if (name === 'see_captcha') return found;
    if (!found.present) {
      return {
        ok: false,
        error: '未识别到 Turnstile/reCAPTCHA/hCaptcha iframe。拼图滑块用 screenshot 后 calibrate_drag；勾选类用 click_captcha',
        ...found,
      };
    }
    const clicked = await runOnTab(tabId, [], () => {
      const iframe = [...document.querySelectorAll('iframe')].find((node) => /turnstile|recaptcha|hcaptcha/.test(node.src || ''));
      if (iframe) {
        iframe.click();
        return {ok: true, clicked: true};
      }
      const box = document.querySelector('[name=cf-turnstile-response],input[name=h-captcha-response],textarea[name=g-recaptcha-response]')
        ?.closest('form')
        ?.querySelector('input[type=checkbox],div[role=checkbox]');
      if (box) {
        box.click();
        return {ok: true, clicked: true};
      }
      return {ok: false, error: '验证码 iframe 无法点击，用 screenshot 后 calibrate_drag 或 click_captcha 再试'};
    });
    return {...found, ...clicked, type: found.type};
  }
  // 设备仿真：模拟移动端视口、UA、触摸
  if (name === 'emulate_device') {
    const device = input.device || 'iPhone 14';
    const devices = {
      'iPhone 14': {width: 390, height: 844, deviceScaleFactor: 3, mobile: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)'},
      'iPhone 14 Pro Max': {width: 430, height: 932, deviceScaleFactor: 3, mobile: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)'},
      'Pixel 7': {width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, userAgent: 'Mozilla/5.0 (Linux; Android 13)'},
      'iPad': {width: 810, height: 1080, deviceScaleFactor: 2, mobile: false, userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)'},
      'desktop': {width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, userAgent: ''},
    };
    const config = devices[device] || devices['desktop'];
    const tab = await getTab(tabId);
    if (!tab?.id) return {ok: false, error: '没有标签'};
    const width = input.width || config.width;
    const height = input.height || config.height;
    const deviceScaleFactor = input.deviceScaleFactor || config.deviceScaleFactor;
    const mobile = input.mobile !== undefined ? input.mobile : config.mobile;
    const userAgent = input.userAgent || config.userAgent;
    try {
      await withDebugger(tab.id, async () => {
        await chrome.debugger.sendCommand({tabId: tab.id}, 'Emulation.setDeviceMetricsOverride', {
          width, height, deviceScaleFactor, mobile,
        });
        if (userAgent) {
          await chrome.debugger.sendCommand({tabId: tab.id}, 'Emulation.setUserAgentOverride', {userAgent});
        }
      });
      return {ok: true, device, width, height, trusted: true};
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {ok: false, error: `CDP emulate_device 失败：${message}`};
    }
  }
  // 网络节流：模拟网络条件
  if (name === 'network_throttle') {
    const profile = input.profile || 'online';
    const profiles = {
      'offline': {offline: true, downloadThroughput: 0, uploadThroughput: 0, latency: 0},
      'slow-3g': {offline: false, downloadThroughput: 50000, uploadThroughput: 50000, latency: 2000},
      'fast-3g': {offline: false, downloadThroughput: 180000, uploadThroughput: 75000, latency: 562},
      '4g': {offline: false, downloadThroughput: 4000000, uploadThroughput: 3000000, latency: 20},
      'online': {offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0},
    };
    const config = profiles[profile] || profiles['online'];
    const tab = await getTab(tabId);
    if (!tab?.id) return {ok: false, error: '没有标签'};
    try {
      await withDebugger(tab.id, async () => {
        await chrome.debugger.sendCommand({tabId: tab.id}, 'Network.enable', {});
        await chrome.debugger.sendCommand({tabId: tab.id}, 'Network.emulateNetworkConditions', config);
      });
      return {ok: true, profile, ...config, trusted: true};
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {ok: false, error: `CDP network_throttle 失败：${message}`};
    }
  }
  // Cookie 操作：设置、删除、清空
  if (name === 'set_cookie') {
    const {url, name: cookieName, value, path, domain, secure, sameSite, expires} = input;
    if (!cookieName || value === undefined) return {ok: false, error: '需要 name 和 value'};
    await chrome.cookies.set({
      url: url || `http${secure ? 's' : ''}://${domain || 'localhost'}${path || '/'}`,
      name: cookieName,
      value: String(value),
      path: path || '/',
      domain: domain,
      secure: secure || false,
      sameSite: sameSite ? (String(sameSite).toLowerCase() === 'none' ? 'no_restriction' : String(sameSite).toLowerCase()) : 'lax',
      expirationDate: expires ? Math.floor(Date.now() / 1000) + expires : undefined,
    });
    return {ok: true, name: cookieName, value};
  }
  if (name === 'delete_cookie') {
    const {url, name: cookieName, path, domain} = input;
    if (!cookieName) return {ok: false, error: '需要 name'};
    await chrome.cookies.remove({url: url || `http://${domain || 'localhost'}${path || '/'}`, name: cookieName});
    return {ok: true, deleted: cookieName};
  }
  if (name === 'clear_cookies') {
    const {origin} = input;
    const cookies = await chrome.cookies.getAll(origin ? {url: origin} : {});
    for (const cookie of cookies) {
      await chrome.cookies.remove({url: `http${cookie.secure ? 's' : ''}://${cookie.domain}${cookie.path}`, name: cookie.name});
    }
    return {ok: true, cleared: cookies.length};
  }
  // iframe 切换：Chrome 扩展限制，无法真正切换 frame 上下文
  if (name === 'switch_frame') {
    return {ok: false, error: 'switch_frame 受 Chrome 安全限制，无法切换 frame；请使用 execute_javascript 操作 iframe 内部'};
  }
  // 右键菜单
  if (name === 'context_menu') {
    const {text} = input;
    const tab = await getTab(tabId);
    if (!tab?.id) return {ok: false, error: '没有标签'};
    try {
      let x;
      let y;
      if (text) {
        const [{result}] = await chrome.scripting.executeScript({
          target: {tabId: tab.id},
          func: (t) => {
            const el = [...document.querySelectorAll('*')].find((e) => e.textContent?.trim() === t);
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
          },
          args: [text],
        });
        if (!result) return {ok: false, error: '未找到目标元素'};
        x = result.x;
        y = result.y;
      } else {
        const viewport = await viewportOf(tab.id);
        if (!viewport) return {ok: false, error: '读不到视口'};
        x = viewport[0] / 2;
        y = viewport[1] / 2;
      }
      await cdpMouse(tab.id, 'mousePressed', x, y, {button: 'right', clickCount: 1});
      await cdpMouse(tab.id, 'mouseReleased', x, y, {button: 'right', clickCount: 1});
      return {ok: true, triggered: true, trusted: true, point: [x, y]};
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {ok: false, error: `CDP context_menu 失败：${message}`};
    }
  }
  // 权限管理：Chrome 安全限制，无法自动处理权限弹窗
  if (name === 'permission_grant' || name === 'permission_deny') {
    return {ok: false, error: `${name} 受 Chrome 安全限制，权限弹窗需要用户在页面上手动点击`};
  }
  // 地理位置
  if (name === 'set_geolocation') {
    const {latitude, longitude, accuracy} = input;
    if (latitude === undefined || longitude === undefined) return {ok: false, error: '需要 latitude 和 longitude'};
    const tab = await getTab(tabId);
    if (!tab?.id) return {ok: false, error: '没有标签'};
    try {
      await withDebugger(tab.id, () => chrome.debugger.sendCommand({tabId: tab.id}, 'Emulation.setGeolocationOverride', {
        latitude: Number(latitude),
        longitude: Number(longitude),
        accuracy: Number(accuracy) || 100,
      }));
      return {ok: true, latitude, longitude, accuracy: accuracy || 100, trusted: true};
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {ok: false, error: `CDP set_geolocation 失败：${message}`};
    }
  }
  // 页面内搜索
  if (name === 'page_find') {
    const {query} = input;
    if (!query) return {ok: false, error: '需要 query'};
    return runOnTab(tabId, [query], (q) => {
      const found = window.find(q);
      const selection = window.getSelection();
      const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      const rect = range ? range.getBoundingClientRect() : null;
      return {ok: true, found, text: selection.toString(), rect: rect ? {x: rect.x, y: rect.y, w: rect.width, h: rect.height} : null};
    });
  }
  // 长按
  if (name === 'long_press') {
    const {text, durationMs} = input;
    const delay = Math.min(Number(durationMs) || 800, 3000);
    const tab = await getTab(tabId);
    if (!tab?.id) return {ok: false, error: '没有标签'};
    try {
      let x;
      let y;
      if (text) {
        const [{result}] = await chrome.scripting.executeScript({
          target: {tabId: tab.id},
          func: (t) => {
            const el = [...document.querySelectorAll('*')].find((e) => e.textContent?.trim() === t);
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
          },
          args: [text],
        });
        if (!result) return {ok: false, error: '未找到目标元素'};
        x = result.x;
        y = result.y;
      } else {
        const viewport = await viewportOf(tab.id);
        if (!viewport) return {ok: false, error: '读不到视口'};
        x = viewport[0] / 2;
        y = viewport[1] / 2;
      }
      await cdpMouse(tab.id, 'mousePressed', x, y, {button: 'left', clickCount: 1, buttons: 1});
      await new Promise((r) => setTimeout(r, delay));
      await cdpMouse(tab.id, 'mouseReleased', x, y, {button: 'left', clickCount: 1, buttons: 0});
      return {ok: true, durationMs: delay, trusted: true, point: [x, y]};
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {ok: false, error: `CDP long_press 失败：${message}`};
    }
  }
  // Service Worker 列表
  if (name === 'service_worker_list') {
    if (!chrome.serviceWorker?.getRegistrations) return {ok: false, error: 'Service Worker API 不可用'};
    const registrations = await chrome.serviceWorker.getRegistrations();
    const sws = registrations.map((r) => ({scope: r.scope, active: r.active?.scriptURL, installing: r.installing?.scriptURL, waiting: r.waiting?.scriptURL}));
    return {ok: true, serviceWorkers: sws};
  }
  // WebSocket 监控
  if (name === 'websocket_monitor') {
    const {action} = input;
    if (action === 'start') {
      return runOnTab(tabId, [], () => {
        if (window.__wsMonitor) return {ok: true, already: true};
        window.__wsMessages = [];
        const origSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function(...args) {
          window.__wsMessages.push({dir: 'out', data: args[0], time: Date.now()});
          return origSend.apply(this, args);
        };
        const origAddEventListener = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function(type, ...args) {
          if (this instanceof WebSocket && type === 'message') {
            const origHandler = args[0];
            args[0] = function(event) {
              window.__wsMessages.push({dir: 'in', data: event.data, time: Date.now()});
              return origHandler.call(this, event);
            };
          }
          return origAddEventListener.call(this, type, ...args);
        };
        window.__wsMonitor = true;
        return {ok: true, started: true};
      });
    }
    if (action === 'stop') {
      return runOnTab(tabId, [], () => {
        window.__wsMonitor = false;
        const messages = window.__wsMessages || [];
        return {ok: true, stopped: true, messages: messages.slice(-50)};
      });
    }
    if (action === 'read') {
      return runOnTab(tabId, [], () => {
        return {ok: true, messages: (window.__wsMessages || []).slice(-50)};
      });
    }
    return {ok: false, error: '需要 action=start|stop|read'};
  }
  return {ok: false, error: `未接执行器 ${name}`};
};
