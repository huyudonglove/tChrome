import type { BrowserHost, CurrentPage, ToolArguments, ToolIOItem, ToolReturn } from "../types.ts";

export const WINDOW_TEXT_LIMIT = 2000;
export const BROWSER_TOOLS = ["page.current", "page.read", "page.open", "web.search"] as const;

export function clipReturn(full: string): ToolReturn {
  const totalChars = full.length;
  if (totalChars <= WINDOW_TEXT_LIMIT) {
    return { stage: "complete", totalChars, text: full };
  }
  return { stage: "truncated", totalChars, text: full.slice(0, WINDOW_TEXT_LIMIT) };
}

export function actionFromContent(content: string): string {
  const match = content.match(/(?:^|\n)action\n([\s\S]*)$/i);
  return (match?.[1] ?? content).trim();
}

export function questionFromContent(content: string, choice: string[]): string {
  const action = actionFromContent(content);
  if (choice.length === 0) return action;
  return `${action}\n选项：${choice.join(" / ")}`;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function toolUsageFor(ids: string[]): string {
  const usage: Record<string, string> = {
    "page.current": "page.current：读当前活动页的 tab / url / title。affectsPage=false。",
    "page.read": "page.read：读当前页正文。affectsPage=false。",
    "page.open": "page.open：在当前标签打开 url。affectsPage=true。",
    "web.search": "web.search：用检索词打开搜索页并读结果。query 是检索词。affectsPage=true。",
  };
  return ids.map((id) => usage[id] ?? "").filter(Boolean).join("\n");
}

export const pageFromBrowser = (result: {
  ok?: boolean;
  tab?: number | null;
  url?: string;
  title?: string;
  description?: string;
}): CurrentPage | null => {
  if (!result.ok || !result.tab) return null;
  return {
    description: result.description || "当前页面信息",
    tab: Number(result.tab),
    url: String(result.url ?? ""),
    title: String(result.title ?? ""),
  };
};

export type ExecuteInput = {
  name: string;
  arguments: ToolArguments;
  content: string;
  host?: BrowserHost;
  lookup: {
    toolIO: ToolIOItem[];
    fullReturn: (callId: string) => string | null;
    observationFull: (observationId: string) => string | null;
  };
};

export async function executeTool(input: ExecuteInput): Promise<string> {
  const { name, arguments: args, content, lookup, host } = input;
  if (name === "finishTurn") return actionFromContent(content);
  if (name === "askUser") return questionFromContent(content, asStringArray(args.choice));
  if (name === "memory.write") {
    const turn = asStringArray(args.turnMemory).length;
    const conversation = asStringArray(args.conversationMemory).length;
    const project = asStringArray(args.projectMemory).length;
    return `落下 turn=${turn} conversation=${conversation} project=${project}`;
  }
  if (name === "tool.detail") {
    const callId = String(args.callId ?? "");
    const full = lookup.fullReturn(callId);
    if (full !== null) return full;
    const item = lookup.toolIO.find((row) => row.callId === callId);
    return item?.return.text ?? `没有 ${callId} 的全文`;
  }
  if (name === "observation.detail") {
    const observationId = String(args.observationId ?? "");
    return lookup.observationFull(observationId) ?? `没有 ${observationId}`;
  }
  if ((BROWSER_TOOLS as readonly string[]).includes(name)) {
    if (!host) return `${name} 没有浏览器桥`;
    const extra: Record<string, unknown> = {};
    if (name === "page.open") extra.url = String(args.url ?? "");
    if (name === "web.search") extra.query = String(args.query ?? "");
    const result = await host.execute(name, extra);
    return JSON.stringify(result);
  }
  return `${name} 未接`;
}
