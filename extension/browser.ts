const isBlocked = (url = "") => url.startsWith("chrome://") || url.startsWith("chrome-extension://");

const currentTab = async () => {
  const focused = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = focused[0];
  if (tab?.id && !isBlocked(tab.url)) return tab;
  const [fallback] = await chrome.tabs.query({ active: true, currentWindow: true });
  return fallback ?? null;
};

const waitComplete = (tabId: number) =>
  new Promise<void>((resolve) => {
    const finish = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === "complete") finish();
    };
    const timer = setTimeout(finish, 15000);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish();
    });
  });

const readText = async (tabId: number) => {
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.body?.innerText?.slice(0, 8000) ?? "",
  });
  return String(injected?.result ?? "");
};

const pageInfo = async (tab: chrome.tabs.Tab) => ({
  ok: true as const,
  tab: tab.id,
  url: tab.url ?? "",
  title: tab.title ?? "",
  description: "当前页面信息",
});

export async function runBrowserTool(name: string, input: Record<string, unknown>) {
  if (name === "page.current") {
    const tab = await currentTab();
    if (!tab?.id) return { ok: false, error: "没有当前页" };
    return pageInfo(tab);
  }
  if (name === "page.read") {
    const tab = await currentTab();
    if (!tab?.id) return { ok: false, error: "没有当前页" };
    const text = await readText(tab.id);
    return { ...await pageInfo(tab), text };
  }
  if (name === "page.open") {
    const url = String(input.url ?? "");
    const tab = await currentTab();
    const next = tab?.id ? await chrome.tabs.update(tab.id, { url }) : await chrome.tabs.create({ url });
    if (!next?.id) return { ok: false, error: "打不开" };
    await waitComplete(next.id);
    const fresh = await chrome.tabs.get(next.id);
    return pageInfo(fresh);
  }
  if (name === "web.search") {
    const query = String(input.query ?? "");
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    const opened = await runBrowserTool("page.open", { url });
    if (!opened.ok || !opened.tab) return opened;
    const text = await readText(Number(opened.tab));
    return { ...opened, text };
  }
  return { ok: false, error: `未知浏览器工具 ${name}` };
}
