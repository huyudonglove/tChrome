// 「正在操作的标签」可见标识。
// 把当前操作的标签放进一个带颜色和标题的原生标签组，用户看标签栏就能知道 Helm 正在动哪个页面。
// 切换操作目标时标识跟着转移，并把上一个标签尽量放回它原来的分组。
// 最后一次操作后空闲一段时间（TAB_MARK_IDLE_MINUTES）自动清除，避免一直显示「正在操作」。
export const TAB_MARK_TITLE = 'Helm 操作中';
export const TAB_MARK_COLOR = 'cyan';
// 空闲超时清除用的 alarm 名。chrome.alarms 最小粒度是 30 秒，这里取 1 分钟。
export const TAB_MARK_CLEAR_ALARM = 'tchrome-tab-mark-clear';
export const TAB_MARK_IDLE_MINUTES = 1;

// {tabId, groupId, previousGroupId}：previousGroupId 记录分组前的归属，切换后可以还原。
let markState = null;
let queue = Promise.resolve();

const canGroup = () => Boolean(globalThis.chrome?.tabs?.group && globalThis.chrome?.tabGroups?.update);
const canAlarm = () => Boolean(globalThis.chrome?.alarms?.create);

// service worker 被回收后内存状态会丢，旧分组却还留在标签栏上；重新标记或超时清理前先按标题清掉。
const ungroupStale = async () => {
  try {
    const groups = await chrome.tabGroups.query({title: TAB_MARK_TITLE});
    for (const group of groups) {
      const tabs = await chrome.tabs.query({groupId: group.id});
      const ids = tabs.map((tab) => tab.id).filter((id) => Number.isInteger(id));
      if (ids.length) await chrome.tabs.ungroup(ids);
    }
  } catch { /* 分组查询不可用时忽略：标记只是辅助，不能影响工具调用 */ }
};

const restorePreviousGroup = async (tabId, previousGroupId) => {
  try {
    if (previousGroupId >= 0) {
      const group = await chrome.tabGroups.get(previousGroupId).catch(() => null);
      if (group) {
        await chrome.tabs.group({tabIds: [tabId], groupId: previousGroupId});
        return;
      }
    }
    await chrome.tabs.ungroup(tabId);
  } catch { /* 标签已关闭或原分组已消失时无需恢复 */ }
};

// 每次标记都把定时器往后推：连续操作期间标识保持，停下来一段时间后才清。
const scheduleAutoClear = async () => {
  if (!canAlarm()) return;
  try {
    await chrome.alarms.create(TAB_MARK_CLEAR_ALARM, {delayInMinutes: TAB_MARK_IDLE_MINUTES});
  } catch { /* 定时器不可用时退化为「下次操作前清理」，不能影响工具调用 */ }
};

const mark = async (tabId) => {
  if (!Number.isInteger(tabId) || tabId < 0) return {ok: false, error: '需要有效的 tabId'};
  if (!canGroup()) return {ok: false, error: '当前 Chrome 不支持标签分组'};
  if (markState?.tabId === tabId) {
    await scheduleAutoClear();
    return {ok: true, unchanged: true, tabId};
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.id) return {ok: false, error: `标签 ${tabId} 不存在`};
  const previousGroupId = Number.isInteger(tab.groupId) ? tab.groupId : -1;
  const previous = markState;
  markState = null;
  if (previous) await restorePreviousGroup(previous.tabId, previous.previousGroupId);
  await ungroupStale();
  const groupId = await chrome.tabs.group({tabIds: [tab.id], createProperties: {windowId: tab.windowId}});
  await chrome.tabGroups.update(groupId, {title: TAB_MARK_TITLE, color: TAB_MARK_COLOR, collapsed: false});
  markState = {tabId: tab.id, groupId, previousGroupId};
  await scheduleAutoClear();
  return {ok: true, tabId: tab.id, groupId};
};

// 清除标识：有内存状态就按记录还原原分组，否则按标题清掉残留分组（service worker 重启后的兜底）。
const clear = async () => {
  try {
    const previous = markState;
    markState = null;
    if (canAlarm()) await chrome.alarms.clear(TAB_MARK_CLEAR_ALARM).catch(() => false);
    if (previous) await restorePreviousGroup(previous.tabId, previous.previousGroupId);
    else await ungroupStale();
    return {ok: true, cleared: true, tabId: previous?.tabId ?? null};
  } catch (error) {
    return {ok: false, cleared: false, error: String(error)};
  }
};

// 串行执行：连续的工具调用不会互相抢分组，最后一个目标获胜。
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
