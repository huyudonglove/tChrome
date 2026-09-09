import runtimeMessages from "../runtime/messages.json";
import type { ToolEffect, ToolExecution } from "./effects.ts";
import type { BrowserHost, CurrentPage, ToolArguments, ToolIOItem, ToolReturn } from "../types.ts";
import { queryRecord, RECORD_TOOLS } from "./records.ts";
import { SERVICE_TOOL_NAMES, runServiceTool } from "./service-tools.ts";
import { LOCAL_TOOL_NAMES, runLocalTool } from "./local-tools.ts";

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
  // A target tab alone (for example a JavaScript value) is not a page observation.
  if (typeof result.url !== "string" || !result.url || typeof result.title !== "string") return null;
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
  conversationId?: string;
  browserNames: string[];
  host?: BrowserHost;
  lookup: {
    toolIO: ToolIOItem[];
    fullReturn: (callId: string) => string | null;
    observationFull: (observationId: string) => string | null;
    unusedTools: string[];
    knownTools: string[];
    enabledTools: string[];
  };
};

const result = (text: string, effects: ToolEffect[] = []): ToolExecution => ({ text, effects });

const externalResult = (value: Record<string, unknown>): ToolExecution => {
  const page = pageFromBrowser(value);
  return result(JSON.stringify(value), page ? [{ type: "page.set", page }] : []);
};

export async function executeTool(input: ExecuteInput): Promise<ToolExecution> {
  const { name, arguments: args, content, lookup, host, dataDir, browserNames } = input;
  if (name === "finishTurn") {
    const text = closingText(args.text, content);
    return text ? result(text, [{ type: "turn.reply", text }])
      : result(runtimeMessages.emptyFinishTurn, [{ type: "queue.clear" }]);
  }
  if (name === "askUser") {
    const question = questionWithChoices(closingText(args.question, content), asStringArray(args.choice));
    return result(question, [{ type: "turn.ask", question }]);
  }
  if (name === "submitGoal") {
    const goal = String(args.goal ?? "").trim();
    return goal ? result(`当前目标：${goal}`, [{ type: "goal.set", goal }]) : result("goal 空着");
  }
  if (name === "notes.write") {
    const key = String(args.key ?? "").trim();
    const value = String(args.value ?? "");
    return key ? result(`notes[${key}]=${value}`, [{ type: "note.write", key, value }]) : result("key 空着");
  }
  if (name === "notes.delete") {
    const key = String(args.key ?? "").trim();
    return key ? result(`deleted notes[${key}]`, [{ type: "note.delete", key }]) : result("key 空着");
  }
  if (name === "catalog.add") {
    const names = [...new Set(asStringArray(args.names))];
    const added = names.filter((id) => lookup.knownTools.includes(id) && !lookup.enabledTools.includes(id));
    const alreadyEnabled = names.filter((id) => lookup.enabledTools.includes(id));
    const unknown = names.filter((id) => !lookup.knownTools.includes(id) && !lookup.enabledTools.includes(id));
    return result(JSON.stringify({ ok: unknown.length === 0, added, alreadyEnabled, unknown }),
      added.length ? [{ type: "tools.enable", names: added }] : []);
  }
  if (name === "list_browser_tools") {
    return result(JSON.stringify({ ok: true, tools: lookup.unusedTools }));
  }
  if (name === "memory.write") {
    const entries = (["conversation", "project"] as const).flatMap((layer) =>
      asStringArray(args[`${layer}Memory`]).map((text) => ({ layer, text })));
    const summary = asObject(args.contextSummary);
    const effects: ToolEffect[] = entries.length ? [{ type: "memory.append", entries }] : [];
    if (summary) effects.push({ type: "context-summary.set", summary });
    const count = (layer: string) => entries.filter((entry) => entry.layer === layer).length;
    return result(`落下 conversation=${count("conversation")} project=${count("project")}`, effects);
  }
  if (RECORD_TOOLS.includes(name)) {
    const id = String(args.id);
    const full = args.kind === "tool" ? lookup.fullReturn(id) : lookup.observationFull(id);
    return result(queryRecord(name, args, full));
  }
  if (name === "tool.detail") {
    const callId = String(args.callId ?? "");
    const full = lookup.fullReturn(callId);
    if (full !== null) return result(full);
    const item = lookup.toolIO.find((row) => row.callId === callId);
    return result(item?.return.text ?? `没有 ${callId} 的全文`);
  }
  if (name === "observation.detail") {
    const observationId = String(args.observationId ?? "");
    return result(lookup.observationFull(observationId) ?? `没有 ${observationId}`);
  }
  if ((LOCAL_TOOL_NAMES as readonly string[]).includes(name)) {
    if (!input.conversationId) return externalResult({ ok: false, error: "本地工具缺少会话标识" });
    return externalResult(await runLocalTool(name, hostArgs(args), dataDir, input.conversationId));
  }
  if ((SERVICE_TOOL_NAMES as readonly string[]).includes(name)) {
    return externalResult(await runServiceTool(dataDir, name, hostArgs(args)));
  }
  if (browserNames.includes(name)) {
    if (!host) return result(`${name} 没有浏览器桥`);
    return externalResult(await host.execute(name, hostArgs(args)));
  }
  return result(`${name} 未接`);
}
