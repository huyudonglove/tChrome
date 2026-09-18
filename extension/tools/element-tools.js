// Runs in Chrome's isolated world; keep this function self-contained.
export async function elementTool(action, input = {}) {
  if (action === 'click' && input.targetText !== undefined
    && (typeof input.targetText !== 'string' || !input.targetText.trim())) {
    return {ok: false, faultCode: 'invalid_arguments', error: 'targetText 必须是用于定位点击控件的非空字符串'};
  }
  if (action === 'select' && (typeof input.ref !== 'string' || !input.ref || typeof input.value !== 'string')) {
    return {ok: false, faultCode: 'invalid_arguments', error: 'select 需要下拉框 ref 和选项 value 字符串'};
  }
  const selector = 'a,button,input:not([type=hidden]),textarea,select,[role="button"],[contenteditable="true"]';
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const nodes = [...document.querySelectorAll(selector)].filter(visible);
  const state = globalThis.__tChromeElementRefs ??= {refs: new Map(), ids: new WeakMap()};
  const pageState = globalThis.__tChromePageIds ??= {pageElement: new WeakMap(), pageRegion: new WeakMap()};
  for (const [ref, node] of state.refs) if (!node.isConnected) state.refs.delete(ref);
  // Canonical agent handle is page.* e_ / r_ (same allocator as page.list_*).
  const refOf = async (node) => {
    if (!pageState.pageElement.has(node)) {
      pageState.pageElement.set(node, chrome.runtime.sendMessage({type: "allocate-browser-id", kind: "pageElement"}).then(result => {
        if (!result?.id) throw new Error(result?.error || "无法分配元素编号");
        return result.id;
      }));
    }
    const ref = await pageState.pageElement.get(node);
    state.refs.set(ref, node);
    state.ids.set(node, ref);
    return ref;
  };
  const resolveId = async (node, kind) => {
    const map = kind === 'pageRegion' ? pageState.pageRegion : pageState.pageElement;
    if (!map.has(node)) return null;
    const value = map.get(node);
    return value && typeof value.then === 'function' ? value.catch(() => null) : value;
  };
  const findById = async (id) => {
    let node = state.refs.get(id);
    if (node && node.isConnected && nodes.includes(node)) return node;
    node = null;
    for (const candidate of nodes) {
      const pageId = await resolveId(candidate, 'pageElement');
      if (pageId === id) { node = candidate; break; }
    }
    return node;
  };
  const labelOf = (node) => {
    const explicit = node.id ? document.querySelector(`label[for="${CSS.escape(node.id)}"]`)?.innerText : '';
    return (explicit || node.closest('label')?.innerText || '').trim();
  };
  const textOf = (node) => [node.innerText, node.value, node.getAttribute('aria-label'), node.getAttribute('placeholder'), node.name, labelOf(node)].filter(Boolean).join(' ');
  const row = async (node) => {
    const rect = node.getBoundingClientRect();
    const ref = await refOf(node);
    return {
      id: ref,
      ref,
      ...(node.id ? {domId: node.id} : {}),
      tag: node.tagName.toLowerCase(), role: node.getAttribute('role') || '',
      text: (node.innerText || node.getAttribute('aria-label') || '').trim().slice(0, 100),
      label: labelOf(node).slice(0, 100), placeholder: node.getAttribute('placeholder') || '', name: node.name || '', type: node.type || '',
      value: 'value' in node ? String(node.value).slice(0, 100) : '', href: node.href || '',
      ...(node.tagName === 'SELECT' ? {options: [...node.options].map(option => ({value: option.value, text: option.text, disabled: option.disabled}))} : {}),
      disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true'),
      checked: 'checked' in node ? Boolean(node.checked) : undefined, required: Boolean(node.required),
      rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
    };
  };
  if (action === 'snapshot_page' || action === 'find_on_page') {
    if (action === 'find_on_page' && (typeof input.text !== 'string' || !input.text.trim())) return {ok: false, error: 'find_on_page 需要非空 text'};
    const query = (input.text || '').trim().toLocaleLowerCase();
    const hits = nodes.filter(node => !query || textOf(node).toLocaleLowerCase().includes(query) || String(node.href || '').toLocaleLowerCase().includes(query));
    const limit = Math.min(100, Math.max(1, Number(input.limit) || 40));
    return {ok: true, title: document.title, url: location.href, elements: await Promise.all(hits.slice(0, limit).map(row)), total: hits.length, truncated: hits.length > limit};
  }
  let hit;
  const rawRef = input.ref;
  if (rawRef !== undefined) {
    if (typeof rawRef !== 'string' || !/^(?:e|r)_[0-9]{2,}$/.test(rawRef)) {
      return {ok: false, faultCode: 'invalid_ref', error: 'ref/id 必须是 page.* 或 snapshot 返回的 e_/r_ 编号'};
    }
    hit = await findById(rawRef);
    if (!hit || !hit.isConnected || !nodes.includes(hit)) {
      return {ok: false, faultCode: 'stale_ref', error: '编号已失效或元素不可见，请重新 list/snapshot；不会按文字回退点击'};
    }
  } else {
    const query = (action === 'type' ? input.target : action === 'click' ? input.targetText : input.text)?.trim();
    if (!query) return {ok: false, error: action === 'type' ? '需要 ref/id 或非空 target' : action === 'click' ? '需要 e_ 编号，或非空 targetText' : '需要 ref/id 或非空 text'};
    const hits = nodes.filter(node => textOf(node).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    if (hits.length !== 1) return {ok: false, faultCode: hits.length ? 'ambiguous_target' : 'target_not_found', error: hits.length ? '多个控件匹配，请用 snapshot_page/find_on_page 获取 id 后指定操作' : '没有匹配控件'};
    hit = hits[0];
  }
  if (hit.disabled || hit.getAttribute('aria-disabled') === 'true') return {ok: false, error: '目标控件不可用'};
  if (action === 'select') {
    if (hit.tagName !== 'SELECT') return {ok: false, error: 'ref 指向的目标不是下拉框'};
    const option = [...hit.options].find(item => item.value === input.value);
    if (!option || option.disabled) return {ok: false, error: '没有可用的匹配选项 value'};
    hit.value = option.value;
    hit.dispatchEvent(new Event('input', {bubbles: true}));
    hit.dispatchEvent(new Event('change', {bubbles: true}));
    return {ok: true, value: hit.value};
  }
  if (action === 'type') {
    if (!hit.matches('input:not([type=hidden]),textarea,[contenteditable="true"]') || hit.readOnly
      || (hit.tagName === 'INPUT' && !['text','search','tel','url','email','password','number','date','datetime-local','month','week','time'].includes(hit.type))) return {ok: false, error: '目标不是可编辑输入框'};
    if (typeof input.text !== 'string') return {ok: false, error: 'text 必须是字符串'};
    hit.focus();
    if ('value' in hit) {
      const proto = hit instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(hit, input.text); else hit.value = input.text;
    } else hit.textContent = input.text;
    const actual = 'value' in hit ? hit.value : hit.textContent;
    if (actual !== input.text) return {ok: false, value: actual, error: '控件未接受完整输入，请检查控件格式要求'};
    hit.dispatchEvent(new Event('input', {bubbles: true}));
    hit.dispatchEvent(new Event('change', {bubbles: true}));
    return {ok: true, value: actual};
  }
  if (action === 'double_click') hit.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));
  else if (action === 'focus') hit.focus();
  else if (action === 'hover') hit.dispatchEvent(new MouseEvent('mouseover', {bubbles: true}));
  else hit.click();
  return {ok: true, clicked: textOf(hit).slice(0, 100)};
}
