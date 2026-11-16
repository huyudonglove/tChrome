import { describe, expect, test } from "bun:test";
import {
  clearActiveTabMark,
  markActiveTab,
  readActiveTabMark,
  TAB_MARK_CLEAR_ALARM,
  TAB_MARK_COLOR,
  TAB_MARK_TITLE,
} from "./tab-marker.js";

// tab-marker 用扩展图标角标 + 图标提示表明「正在操作哪个标签」，不再使用标签分组。
// 这里用假 chrome 记录调用序列：角标要随目标转移、空闲后清除，且全程不能碰标签栏。
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

const makeChrome = (tabs: Record<number, any>) => {
  const calls: string[] = [];
  const fake = {
    tabs: {
      get: async (id: number) => {
        const tab = tabs[id];
        return tab ? { id, ...tab } : null;
      },
      // 分组 API 只在旧方案里用；留着记录，一旦被调用测试就能抓到回归。
      group: async () => {
        calls.push("tabs.group");
        return 1;
      },
      ungroup: async () => {
        calls.push("tabs.ungroup");
      },
    },
    action: {
      setBadgeText: async (props: any) => {
        calls.push(`badge:${props.text}`);
      },
      setBadgeBackgroundColor: async (props: any) => {
        calls.push(`badge-color:${props.color}`);
      },
      setTitle: async (props: any) => {
        calls.push(`title:${props.title}`);
      },
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

describe("tab-marker", () => {
  test("首个目标标签用图标角标标出来，且不动标签栏", async () => {
    const { fake, calls } = makeChrome({ 5: { title: "示例页" } });
    await withChrome(fake, async () => {
      const result = await markActiveTab(5);
      expect(result.ok).toBe(true);
      expect(calls[0]).toBe("badge:•");
      expect(calls[1]).toBe(`badge-color:${TAB_MARK_COLOR}`);
      expect(calls[2]).toBe(`title:${TAB_MARK_TITLE}：示例页`);
      // 标记后必须排上自动清除定时器，否则角标会一直挂着。
      expect(calls.some((call) => call.startsWith(`alarm:${TAB_MARK_CLEAR_ALARM}`))).toBe(true);
      expect(readActiveTabMark()).toMatchObject({ tabId: 5 });
      // 关键回归点：任何分组调用都会让标签栏重排。
      expect(calls.filter((call) => call.startsWith("tabs."))).toEqual([]);
    });
  });

  test("切换目标时角标与提示跟着换，仍然不重组标签", async () => {
    const { fake, calls } = makeChrome({
      5: { title: "示例页" },
      9: { title: "另一个页面" },
    });
    await withChrome(fake, async () => {
      await markActiveTab(5);
      calls.length = 0;
      const result = await markActiveTab(9);
      expect(result.ok).toBe(true);
      expect(calls).toEqual([
        "badge:•",
        `badge-color:${TAB_MARK_COLOR}`,
        `title:${TAB_MARK_TITLE}：另一个页面`,
        `alarm:${TAB_MARK_CLEAR_ALARM}:{"delayInMinutes":1}`,
      ]);
      expect(readActiveTabMark()).toMatchObject({ tabId: 9 });
    });
  });

  test("同一标签重复标记不再重设角标，但会顺延自动清除定时器", async () => {
    const { fake, calls } = makeChrome({ 5: { title: "示例页" } });
    await withChrome(fake, async () => {
      await markActiveTab(5);
      calls.length = 0;
      expect(await markActiveTab(5)).toMatchObject({ ok: true, unchanged: true });
      expect(calls.filter((call) => call.startsWith("badge:") || call.startsWith("title:"))).toEqual([]);
      expect(calls.some((call) => call.startsWith(`alarm:${TAB_MARK_CLEAR_ALARM}`))).toBe(true);
    });
  });

  test("空闲超时清除角标并恢复图标标题", async () => {
    const { fake, calls } = makeChrome({ 5: { title: "示例页" } });
    await withChrome(fake, async () => {
      await markActiveTab(5);
      calls.length = 0;
      const cleared = await clearActiveTabMark();
      expect(cleared).toMatchObject({ ok: true, cleared: true, tabId: 5 });
      expect(calls).toContain(`alarm-clear:${TAB_MARK_CLEAR_ALARM}`);
      expect(calls).toContain("badge:");
      expect(calls).toContain("title:Open Helm");
      expect(readActiveTabMark()).toBeNull();
    });
  });

  test("没有内存状态时也能清掉残留角标（worker 重启兜底）", async () => {
    const { fake, calls } = makeChrome({});
    await withChrome(fake, async () => {
      const cleared = await clearActiveTabMark();
      expect(cleared).toMatchObject({ ok: true, cleared: true });
      expect(cleared).toMatchObject({ tabId: null });
      expect(calls).toContain("badge:");
    });
  });

  test("不支持图标角标的环境返回失败但不抛错", async () => {
    await withChrome({ tabs: {} }, async () => {
      expect(await markActiveTab(5)).toMatchObject({ ok: false });
    });
  });

  test("目标标签不存在时返回失败", async () => {
    const { fake } = makeChrome({});
    await withChrome(fake, async () => {
      expect(await markActiveTab(5)).toMatchObject({ ok: false });
    });
  });
});
