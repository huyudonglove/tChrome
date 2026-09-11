// This function runs in each frame; keep all DOM helpers inside it.
export function inspectCaptchaFrame(click, deadline) {
  const visible = (node) => Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
  const classify = (value) => {
    try {
      const url = new URL(value, location.href);
      const host = url.hostname;
      if (host === 'challenges.cloudflare.com') return 'turnstile';
      if (/(^|\.)(google\.com|google\.cn|recaptcha\.net)$/.test(host) && url.pathname.includes('/recaptcha/')) return 'recaptcha';
      if (/(^|\.)hcaptcha\.com$/.test(host)) return 'hcaptcha';
    } catch {}
    return null;
  };
  const frameType = classify(location.href);
  const types = new Set();
  if (frameType) types.add(frameType);
  let widgetFrames = 0;
  for (const frame of document.querySelectorAll('iframe')) {
    const type = classify(frame.src || '');
    if (type) {
      types.add(type);
      // Challenge overlays belong to an existing widget, not another widget.
      if (!(type === 'recaptcha' && /bframe/.test(frame.src)) && !(type === 'hcaptcha' && /(?:frame=challenge|challenge\.html)/.test(frame.src))) widgetFrames++;
    }
  }
  let responseCount = 0;
  let completedResponses = 0;
  let containers = 0;
  for (const [selector, type] of [
    ['[name="cf-turnstile-response"]', 'turnstile'],
    ['[name="g-recaptcha-response"]', 'recaptcha'],
    ['[name="h-captcha-response"]', 'hcaptcha'],
  ]) {
    for (const node of document.querySelectorAll(selector)) {
      types.add(type);
      responseCount++;
      if (String(node.value || '').trim()) completedResponses++;
    }
  }
  for (const [selector, type] of [['.cf-turnstile', 'turnstile'], ['.g-recaptcha', 'recaptcha'], ['.h-captcha', 'hcaptcha']]) {
    const count = document.querySelectorAll(selector).length;
    containers += count;
    if (count) types.add(type);
  }
  // Only use provider-specific controls inside provider frames. Never click an iframe
  // or an unrelated form checkbox beside a response field.
  const selector = frameType === 'recaptcha' ? '#recaptcha-anchor'
    : frameType === 'hcaptcha' ? '#checkbox'
      : frameType === 'turnstile' ? 'input[type="checkbox"]' : null;
  const box = selector ? document.querySelector(selector) : null;
  const checked = box && (box.checked === true || box.getAttribute('aria-checked') === 'true');
  const clickable = Boolean(visible(box) && !box.disabled && box.getAttribute('aria-disabled') !== 'true' && !checked);
  let clicked = false;
  if (click && clickable && Date.now() < deadline) { box.click(); clicked = true; }
  return {present: types.size > 0, types: [...types], responseCount, completedResponses,
    widgetCount: Math.max(containers, widgetFrames, frameType ? 1 : 0),
    widgetFrame: Boolean(frameType && !/bframe|frame=challenge|challenge\.html/.test(location.href)), clickable, clicked};
}

async function beforeDeadline(promise, deadline) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('验证码检查超时，页面可能被原生弹窗阻塞')), Math.max(1, deadline - Date.now()));
    })]);
  } finally { clearTimeout(timer); }
}

export async function runCaptchaTool(name, tabId, input = {}) {
  const timeout = Number(input.timeoutMs ?? (name === 'see_captcha' || name === 'click_captcha' ? 3000 : 8000));
  if (!Number.isFinite(timeout) || timeout <= 0) return {ok: false, error: 'timeoutMs 必须是正数'};
  const deadline = Date.now() + Math.min(timeout, 12000);
  let last = {present: false, type: null, status: 'unknown', clickable: false};
  let clicked = false;
  const inspect = async () => {
    let frames;
    let partial = false;
    try {
      frames = await beforeDeadline(chrome.scripting.executeScript({target: {tabId, allFrames: true}, func: inspectCaptchaFrame, args: [false, deadline]}), deadline);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      // A restricted child frame must not hide the top-level response fields.
      partial = true;
      frames = await beforeDeadline(chrome.scripting.executeScript({target: {tabId, frameIds: [0]}, func: inspectCaptchaFrame, args: [false, deadline]}), deadline);
    }
    const valid = frames.filter((frame) => frame.result && !frame.error);
    partial ||= valid.length !== frames.length;
    if (!valid.length) throw new Error('无法读取验证码状态：没有可访问的页面 frame');
    const types = [...new Set(valid.flatMap((frame) => frame.result.types || []))];
    const present = valid.some((frame) => frame.result.present);
    const responseCount = valid.reduce((sum, frame) => sum + (frame.result.responseCount || 0), 0);
    const completedResponses = valid.reduce((sum, frame) => sum + (frame.result.completedResponses || 0), 0);
    // A widget may be represented by its parent iframe and child frame; do not
    // double count those. Multiple response fields or widgets remain ambiguous.
    const ambiguous = types.length > 1 || responseCount > 1 || valid.filter((frame) => frame.result.widgetFrame).length > 1 || valid.some((frame) => frame.result.widgetCount > 1)
      || valid.filter((frame) => frame.result.clickable).length > 1;
    const solved = !partial && !ambiguous && responseCount === 1 && completedResponses === 1;
    last = {present, type: types.length === 1 ? types[0] : types.length ? 'multiple' : null,
      status: solved ? 'solved' : present ? 'challenge' : 'unknown', ...(ambiguous ? {ambiguous: true} : {}),
      clickable: valid.some((frame) => frame.result.clickable), ...(partial ? {partial: true} : {})};
    return valid;
  };
  try {
    let frames = await inspect();
    if (name === 'see_captcha') return {...last, ok: true};
    if (name === 'wait_captcha') {
      while (!last.present && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
        if (Date.now() < deadline) frames = await inspect();
      }
      return last.present ? {...last, ok: true} : {...last, ok: false, error: '等待超时，未检测到受支持的验证码'};
    }
    if (last.ambiguous) return {...last, ok: false, requiresUser: true, clicked: false, error: '检测到多个验证码控件或响应字段，无法将验证结果归属到唯一控件，请用户处理'};
    if (last.status === 'solved') return {...last, ok: true, clicked: false};
    if (!last.present) return {...last, ok: false, clicked: false, error: '未检测到 Turnstile、reCAPTCHA 或 hCaptcha 验证码'};
    const targets = frames.filter((frame) => frame.result.clickable);
    if (targets.length > 1 || last.type === 'multiple') return {...last, ok: false, requiresUser: true, clicked: false, error: '检测到多个验证码控件，无法确定应操作哪一个，请用户处理'};
    if (targets.length === 1) {
      const result = await beforeDeadline(chrome.scripting.executeScript({target: {tabId, frameIds: [targets[0].frameId]}, func: inspectCaptchaFrame, args: [true, deadline]}), deadline);
      clicked = result.some((frame) => frame.result?.clicked);
    }
    if (name === 'click_captcha') return {...last, ok: clicked, clicked, ...(clicked ? {message: '已点击可访问的勾选框；点击不代表验证通过'} : {requiresUser: true, error: '验证码中没有可访问的勾选框；跨域权限、封闭组件或图像挑战需要用户处理'})};
    // solve means observed completion, never merely dispatched a click.
    while (Date.now() < deadline) {
      await inspect();
      if (last.status === 'solved') return {...last, ok: true, clicked};
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
    }
    return {...last, ok: false, clicked, requiresUser: true, error: '等待结束仍未观察到唯一验证码的响应令牌；图像、拼图及不可访问的验证码需要用户处理'};
  } catch (error) {
    return {...last, ok: false, clicked, ...(name === 'solve_captcha' || name === 'click_captcha' ? {requiresUser: true} : {}), error: String(error?.message || error)};
  }
}
