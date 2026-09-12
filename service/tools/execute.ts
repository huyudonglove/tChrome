import runtimeMessages from "../runtime/messages.json";
import type { QueryModule, QueryResult } from "../agents/query/types.ts";
import type { QueryRecord } from "../context/projections/queries.ts";
import type { ToolEffect, ToolExecution } from "./effects.ts";
import type { BrowserHost, CurrentPage, ToolArguments } from "../types.ts";
import { SERVICE_TOOL_NAMES, runServiceTool } from "./service-tools.ts";
import { LOCAL_TOOL_NAMES, runLocalTool } from "./local-tools.ts";
import { listItems, saveItem, deleteItem } from "../library/store.ts";
import { readScript } from "../scripts/store.ts";

const questionWithChoices = (question: string, choice: string[]): string =>
  choice.length === 0 ? question : `${question}\n选项：${choice.join(" / ")}`;

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
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
  dataDir: string;
  conversationId?: string;
  browserNames: string[];
  host?: BrowserHost;
  queryContext?: (args: {sumId: string; module: QueryModule; intent: string; cursor?: string}) => Promise<QueryResult>;
  lookup: {
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
  const { name, arguments: args, lookup, host, dataDir, browserNames } = input;
  if (name === "execute_javascript") {
    try {
      if ("code" in args || typeof args.filename !== "string" || !/\.(?:js|mjs|cjs)$/.test(args.filename)) {
        return result(JSON.stringify({ ok: false, error: "请先用 script_patch 保存 JavaScript 文件，再传 filename 执行。" }));
      }
      if (!host) return result(JSON.stringify({ ok: false, error: "浏览器未连接" }));
      const script = await readScript(dataDir, args.filename);
      return externalResult(await host.execute(name, { code: script.code, ...(args.tab !== undefined ? { tab: args.tab } : {}) }));
    } catch (error) {
      return result(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  if (name === "library") {
    try {
      if (args.action === "list") return result(JSON.stringify({ ok: true, items: listItems(dataDir, typeof args.query === "string" ? args.query : undefined) }));
      if (args.action === "get") {
        const item = listItems(dataDir).find(item => item.id === args.id);
        return result(JSON.stringify(item ? { ok: true, item } : { ok: false, error: "资料不存在" }));
      }
      if (args.action === "save") {
        const fields = hostArgs(args);
        delete fields.action;
        delete fields.query;
        return result(JSON.stringify({ ok: true, item: saveItem(dataDir, fields) }));
      }
      if (args.action === "delete") {
        deleteItem(dataDir, String(args.id ?? ""));
        return result(JSON.stringify({ ok: true }));
      }
      return result(JSON.stringify({ ok: false, error: "未知资料操作" }));
    } catch (error) {
      return result(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  if (name === "finishTurn") {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    return text ? result(text, [{ type: "turn.reply", text }])
      : result(runtimeMessages.emptyFinishTurn, [{ type: "queue.clear" }]);
  }
  if (name === "askUser") {
    const text = typeof args.question === "string" ? args.question.trim() : "";
    if (!text) return result(runtimeMessages.emptyAskUser, [{ type: "queue.clear" }]);
    const question = questionWithChoices(text, asStringArray(args.choice));
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
    const effects: ToolEffect[] = entries.length ? [{ type: "memory.append", entries }] : [];
    const count = (layer: string) => entries.filter((entry) => entry.layer === layer).length;
    return result(`落下 conversation=${count("conversation")} project=${count("project")}`, effects);
  }
  if (name === "context.query") {
    if (!input.queryContext) return result(JSON.stringify({ status: "error", error: "query_agent_unavailable" }));
    const queried = await input.queryContext({ sumId: String(args.sumId), module: args.module as QueryModule,
      intent: String(args.intent), ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}) });
    if (queried.status === "cancelled") return result(JSON.stringify({ ok: false, status: "cancelled" }));
    const bounded = JSON.stringify(queried.records).length <= 2000;
    const query = { sumId: queried.sumId, module: queried.module, intent: queried.intent,
      status: bounded ? queried.status : "error" as const,
      records: (bounded ? queried.records : []) as QueryRecord[],
      ...(bounded && queried.nextCursor ? { nextCursor: queried.nextCursor } : {}),
      detail: bounded ? queried.detail : "查询结果超过 2000 字符门禁，未注入原文。" };
    const references = query.records.map(record => Object.fromEntries(Object.entries(record)
      .filter(([key]) => ["id", "turnId", "callId", "memoryId", "sumId", "queryId"].includes(key))));
    return result(JSON.stringify({ ok: bounded && queried.ok, status: query.status,
      sumId: query.sumId, module: query.module, records: references,
      ...(query.nextCursor ? { nextCursor: query.nextCursor } : {}), detail: query.detail }),
      [{ type: "query.set", query }]);
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
