// 「正在操作的标签」可见标识。
// 用扩展图标角标 + 图标提示说明 Helm 正在动哪个页面，全程不碰标签栏：
// 原先用 chrome.tabs.group 建原生分组，分组会把目标标签从原位置搬走并染色，
// 切换目标时再 ungroup/group 一次，标签栏因此不断重排——所以放弃分组方案。
// 最后一次操作后空闲一段时间（TAB_MARK_IDLE_MINUTES）自动清除，避免一直显示「正在操作」。
export const TAB_MARK_TITLE = 'Helm 操作中';
export const TAB_MARK_COLOR = '#ff6a00';
// 空闲超时清除用的 alarm 名。chrome.alarms 最小粒度是 30 秒，这里取 1 分钟。
export const TAB_MARK_CLEAR_ALARM = 'tchrome-tab-mark-clear';
export const TAB_MARK_IDLE_MINUTES = 1;
// manifest 里的 action.default_title；清除标识时恢复它。
const DEFAULT_ACTION_TITLE = 'Open Helm';

// {tabId}：只记当前被操作的标签，用于「同一标签重复标记」判断与清除时的回报。
let markState = null;
let queue = Promise.resolve();

const canAction = () => Boolean(globalThis.chrome?.action?.setBadgeText);
const canAlarm = () => Boolean(globalThis.chrome?.alarms?.create);

// 每次标记都把定时器往后推：连续操作期间标识保持，停下来一段时间后才清。
const scheduleAutoClear = async () => {
  if (!canAlarm()) return;
  try {
    await chrome.alarms.create(TAB_MARK_CLEAR_ALARM, {delayInMinutes: TAB_MARK_IDLE_MINUTES});
  } catch { /* 定时器不可用时退化为「下次操作前清理」，不能影响工具调用 */ }
};

// 角标只承载「正在操作」这一个状态，不需要数字，用一个圆点。
const paintMark = async (tab) => {
  if (!canAction()) return false;
  try {
    await chrome.action.setBadgeText({text: '•'});
    if (chrome.action.setBadgeBackgroundColor) {
      await chrome.action.setBadgeBackgroundColor({color: TAB_MARK_COLOR});
    }
    const label = tab?.title ? `${TAB_MARK_TITLE}：${tab.title}` : TAB_MARK_TITLE;
    await chrome.action.setTitle({title: label});
    return true;
  } catch {
    return false;
  }
};

const resetMark = async () => {
  if (!canAction()) return false;
  try {
    await chrome.action.setBadgeText({text: ''});
    await chrome.action.setTitle({title: DEFAULT_ACTION_TITLE});
    return true;
  } catch {
    return false;
  }
};

const mark = async (tabId) => {
  if (!Number.isInteger(tabId) || tabId < 0) return {ok: false, error: '需要有效的 tabId'};
  if (!canAction()) return {ok: false, error: '当前 Chrome 不支持图标角标'};
  if (markState?.tabId === tabId) {
    await scheduleAutoClear();
    return {ok: true, unchanged: true, tabId};
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.id) return {ok: false, error: `标签 ${tabId} 不存在`};
  if (!await paintMark(tab)) return {ok: false, error: '无法设置图标角标'};
  markState = {tabId: tab.id};
  await scheduleAutoClear();
  return {ok: true, tabId: tab.id};
};

// 清除标识：撤掉定时器并恢复图标标题（worker 重启后角标可能残留，这里同样是幂等的兜底）。
const clear = async () => {
  try {
    const previous = markState;
    markState = null;
    if (canAlarm()) await chrome.alarms.clear(TAB_MARK_CLEAR_ALARM).catch(() => false);
    await resetMark();
    return {ok: true, cleared: true, tabId: previous?.tabId ?? null};
  } catch (error) {
    return {ok: false, cleared: false, error: String(error)};
  }
};

// 串行执行：连续的工具调用不会互相抢角标，最后一个目标获胜。
// queue 只负责排序（Promise<void>），返回值单独持有，标记结果才不会被吞成 void。
export const markActiveTab = (tabId) => {
  const run = queue.then(() => mark(tabId)).catch(() => ({ok: false}));
  queue = run.then(() => undefined);
  return run;
};

export const clearActiveTabMark = () => {
  const run = queue.then(() => clear()).catch(() => ({ok: false, cleared: false}));
  queue = run.then(() => undefined);
  return run;
};

export const readActiveTabMark = () => markState;
