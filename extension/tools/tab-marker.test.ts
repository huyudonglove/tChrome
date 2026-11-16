import { describe, expect, test } from "bun:test";
import {
  clearActiveTabMark,
  markActiveTab,
  readActiveTabMark,
  TAB_MARK_CLEAR_ALARM,
  TAB_MARK_COLOR,
  TAB_MARK_TITLE,
} from "./tab-marker.js";

// tab-marker 用 chrome.tabs.group / tabGroups.update 给「正在操作的标签」做可见标识。
// 这里用假 chrome 记录调用序列，验证标识会转移、上一个标签会被放回原分组、空闲后自动清除。
const globals = globalThis as any;

const withChrome = async (fake: any, run: () => Promise<void>) => {
  const original = globals.chrome;
  globals.chrome = fake;
  try {
    await run();
  } finally {
    if (original === undefined) delete globals.chrome;
    else globals.chrome = original;
  }
};

const makeChrome = (tabs: Record<number, any>, extra: {groups?: any[]; groupTabs?: any[]} = {}) => {
  const calls: string[] = [];
  const fake = {
    tabs: {
      get: async (id: number) => {
        const tab = tabs[id];
        return tab ? { id, ...tab } : null;
      },
      group: async (options: any) => {
        calls.push(`group:${JSON.stringify(options)}`);
        return options.groupId ?? 1000 + options.tabIds[0];
      },
      ungroup: async (ids: any) => {
        calls.push(`ungroup:${JSON.stringify(ids)}`);
      },
      query: async () => extra.groupTabs ?? [],
    },
    tabGroups: {
      update: async (groupId: number, props: any) => {
        calls.push(`update:${groupId}:${props.title}:${props.color}`);
      },
      get: async (groupId: number) => ({ id: groupId }),
      query: async () => extra.groups ?? [],
    },
    alarms: {
      create: async (name: string, info: any) => {
        calls.push(`alarm:${name}:${JSON.stringify(info)}`);
      },
      clear: async (name: string) => {
        calls.push(`alarm-clear:${name}`);
        return true;
      },
    },
  };
  return { fake, calls };
};

const groupCalls = (calls: string[]) => calls.filter((call) => /^(group|ungroup):/.test(call));

describe("tab-marker", () => {
  test("首个目标标签被标成「Helm 操作中」分组并着色", async () => {
    const { fake, calls } = makeChrome({ 5: { groupId: -1, windowId: 2 } });
    await withChrome(fake, async () => {
      const result = await markActiveTab(5);
      expect(result.ok).toBe(true);
      expect(calls[0]).toBe(`group:${JSON.stringify({ tabIds: [5], createProperties: { windowId: 2 } })}`);
      expect(calls[1]).toBe(`update:1005:${TAB_MARK_TITLE}:${TAB_MARK_COLOR}`);
      // 标记后必须排上自动清除定时器，否则标识会一直挂着。
      expect(calls.some((call) => call.startsWith(`alarm:${TAB_MARK_CLEAR_ALARM}`))).toBe(true);
      expect(readActiveTabMark()).toMatchObject({ tabId: 5, groupId: 1005, previousGroupId: -1 });
    });
  });

  test("切换目标时标识转移，上一个标签被放回它原本的分组", async () => {
    const { fake, calls } = makeChrome({
      5: { groupId: -1, windowId: 2 },
      9: { groupId: 77, windowId: 2 },
    });
    await withChrome(fake, async () => {
      await markActiveTab(5);
      calls.length = 0;
      const result = await markActiveTab(9);
      expect(result.ok).toBe(true);
      // 先还原上一个目标的归属（原本没有分组就 ungroup），再给新目标建组。
      // chrome.tabs.ungroup 同时接受单个 tabId 与数组，这里只关心目标是谁。
      expect(calls[0]).toMatch(/^ungroup:(\[)?5(\])?$/);
      expect(calls[1]).toBe(`group:${JSON.stringify({ tabIds: [9], createProperties: { windowId: 2 } })}`);
      expect(readActiveTabMark()).toMatchObject({ tabId: 9, groupId: 1009, previousGroupId: 77 });
    });
  });

  test("同一标签重复标记不再动分组，但会顺延自动清除定时器", async () => {
    const { fake, calls } = makeChrome({ 5: { groupId: -1, windowId: 2 } });
    await withChrome(fake, async () => {
      await markActiveTab(5);
      calls.length = 0;
      expect(await markActiveTab(5)).toMatchObject({ ok: true, unchanged: true });
      expect(groupCalls(calls)).toEqual([]);
      expect(calls.some((call) => call.startsWith(`alarm:${TAB_MARK_CLEAR_ALARM}`))).toBe(true);
    });
  });

  test("空闲超时清除标识并把标签放回原分组", async () => {
    const { fake, calls } = makeChrome({ 5: { groupId: -1, windowId: 2 } });
    await withChrome(fake, async () => {
      await markActiveTab(5);
      calls.length = 0;
      const cleared = await clearActiveTabMark();
      expect(cleared).toMatchObject({ ok: true, cleared: true, tabId: 5 });
      // clear 先撤掉定时器再还原分组，断言只关心还原目标是谁。
      const ungrouped = calls.filter((call) => call.startsWith("ungroup:"));
      expect(ungrouped).toHaveLength(1);
      expect(ungrouped[0]).toMatch(/^ungroup:(\[)?5(\])?$/);
      expect(calls).toContain(`alarm-clear:${TAB_MARK_CLEAR_ALARM}`);
      expect(readActiveTabMark()).toBeNull();
    });
  });

  test("没有内存状态时按标题清掉残留分组（worker 重启兜底）", async () => {
    const { fake, calls } = makeChrome({}, { groups: [{ id: 900 }], groupTabs: [{ id: 7 }, { id: 8 }] });
    await withChrome(fake, async () => {
      const cleared = await clearActiveTabMark();
      expect(cleared).toMatchObject({ ok: true, cleared: true });
      expect(calls).toContain(`ungroup:${JSON.stringify([7, 8])}`);
    });
  });

  test("不支持标签分组的环境返回失败但不抛错", async () => {
    await withChrome({ tabs: {}, tabGroups: {} }, async () => {
      expect(await markActiveTab(5)).toMatchObject({ ok: false });
    });
  });
});
