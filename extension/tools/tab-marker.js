// 「正在操作的标签」可见标识。
// 把当前操作的标签放进一个带颜色和标题的原生标签组，用户看标签栏就能知道 Helm 正在动哪个页面。
// 切换操作目标时标识跟着转移，并把上一个标签尽量放回它原来的分组。
export const TAB_MARK_TITLE = 'Helm 操作中';
export const TAB_MARK_COLOR = 'cyan';

// {tabId, groupId, previousGroupId}：previousGroupId 记录分组前的归属，切换后可以还原。
let markState = null;
let queue = Promise.resolve();

const canGroup = () => Boolean(globalThis.chrome?.tabs?.group && globalThis.chrome?.tabGroups?.update);

// service worker 被回收后内存状态会丢，旧分组却还留在标签栏上；重新标记前先清掉。
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

const mark = async (tabId) => {
  if (!Number.isInteger(tabId) || tabId < 0) return {ok: false, error: '需要有效的 tabId'};
  if (!canGroup()) return {ok: false, error: '当前 Chrome 不支持标签分组'};
  if (markState?.tabId === tabId) return {ok: true, unchanged: true, tabId};
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
  return {ok: true, tabId: tab.id, groupId};
};

// 串行执行：连续的工具调用不会互相抢分组，最后一个目标获胜。
export const markActiveTab = (tabId) => {
  queue = queue.then(() => mark(tabId)).catch(() => ({ok: false}));
  return queue;
};

export const readActiveTabMark = () => markState;
