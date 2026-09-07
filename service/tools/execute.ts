import type { BrowserHost, CurrentPage, ToolArguments, ToolIOItem, ToolReturn } from "../types.ts";
import { SERVICE_TOOL_NAMES, runServiceTool } from "./service-tools.ts";

export const WINDOW_TEXT_LIMIT = 2000;

export function clipReturn(full: string): ToolReturn {
  const totalChars = full.length;
  if (totalChars <= WINDOW_TEXT_LIMIT) {
    return { stage: "complete", totalChars, text: full };
  }
  return { stage: "truncated", totalChars, text: full.slice(0, WINDOW_TEXT_LIMIT) };
}

export function actionFromContent(content: string): string {
  const match = content.match(/(?:^|\n)action\n([\s\S]*)$/i);
  return (match?.[1] ?? "").trim();
}

export function questionFromContent(content: string, choice: string[]): string {
  return questionWithChoices(actionFromContent(content), choice);
}

const questionWithChoices = (question: string, choice: string[]): string =>
  choice.length === 0 ? question : `${question}\n选项：${choice.join(" / ")}`;

const closingText = (value: unknown, content: string): string =>
  typeof value === "string" && value.trim() ? value.trim() : actionFromContent(content);

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export const pageFromBrowser = (result: {
  ok?: boolean;
  tab?: number | null;
  url?: string;
  title?: string;
  description?: string;
}): CurrentPage | null => {
  if (!result.ok) return null;
  const tab = Number(result.tab);
  if (!Number.isFinite(tab) || tab < 1) return null;
  return {
    description: result.description || "当前页面信息",
    tab,
    url: String(result.url ?? ""),
    title: String(result.title ?? ""),
  };
};

const hostArgs = (args: ToolArguments): Record<string, unknown> => {
  const extra: Record<string, unknown> = { ...args };
  delete extra.reason;
  delete extra.affectsPage;
  return extra;
};

export type ExecuteInput = {
  name: string;
  arguments: ToolArguments;
  content: string;
  dataDir: string;
  browserNames: string[];
  host?: BrowserHost;
  lookup: {
    toolIO: ToolIOItem[];
    fullReturn: (callId: string) => string | null;
    observationFull: (observationId: string) => string | null;
    unusedTools: string[];
  };
};

export async function executeTool(input: ExecuteInput): Promise<string> {
  const { name, arguments: args, content, lookup, host, dataDir, browserNames } = input;
  if (name === "finishTurn") return closingText(args.text, content);
  if (name === "askUser") return questionWithChoices(closingText(args.question, content), asStringArray(args.choice));
  if (name === "submitGoal") {
    const goal = String(args.goal ?? "").trim();
    return goal ? `当前目标：${goal}` : "goal 空着";
  }
  if (name === "notes.write") {
    const key = String(args.key ?? "").trim();
    return key ? `notes[${key}]=${String(args.value ?? "")}` : "key 空着";
  }
  if (name === "notes.delete") {
    const key = String(args.key ?? "").trim();
    return key ? `deleted notes[${key}]` : "key 空着";
  }
  if (name === "catalog.add") {
    const names = asStringArray(args.names);
    return `补上 ${names.join(" ")}`.trim();
  }
  if (name === "list_browser_tools") {
    return JSON.stringify({ ok: true, tools: lookup.unusedTools });
  }
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
  if ((SERVICE_TOOL_NAMES as readonly string[]).includes(name)) {
    const result = await runServiceTool(dataDir, name, hostArgs(args));
    return JSON.stringify(result);
  }
  if (browserNames.includes(name)) {
    if (!host) return `${name} 没有浏览器桥`;
    const result = await host.execute(name, hostArgs(args));
    return JSON.stringify(result);
  }
  return `${name} 未接`;
}
