import { prepareGoalUpdate, type GoalContext } from "../runtime/goals.ts";
import { errorMessage } from "../../shared/errors.ts";
import type { QueryModule, QueryResult } from "../agents/query/types.ts";
import type { QueryRecord } from "../context/projections/queries.ts";
import type { ToolEffect, ToolExecution } from "./effects.ts";
import type { BrowserHost, CurrentPage, ToolArguments } from "../types.ts";
import { SERVICE_TOOL_NAMES, runServiceTool } from "./service-tools.ts";
import { LOCAL_TOOL_NAMES, runLocalTool } from "./local-tools.ts";
import { listItems, saveItem, deleteItem } from "../library/store.ts";
import { readScript } from "../scripts/store.ts";
import { failedTool, normalizeToolExecution } from "./result.ts";

const questionWithChoices = (question: string, choice: string[]): string =>
  choice.length === 0 ? question : `${question}\n选项：${choice.join(" / ")}`;

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/** Any call that targets a tab is a page observation, including failures; url/title are optional. */
export const pageFromBrowser = (result: {
  ok?: boolean;
  tabId?: number | null;
  url?: string;
  title?: string;
  description?: string;
}): CurrentPage | null => {
  const tabId = Number(result.tabId);
  if (!Number.isFinite(tabId) || tabId < 1) return null;
  return {
    description: result.description || "当前页面信息",
    tabId,
    url: typeof result.url === "string" ? result.url : "",
    title: typeof result.title === "string" ? result.title : "",
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
  goalContext?: GoalContext;
  browserNames: string[];
  host?: BrowserHost;
  signal?: AbortSignal;
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
  return result(JSON.stringify(value), page ? [{ type: "page.set", page, result: value }] : []);
};

export async function executeTool(input: ExecuteInput): Promise<ToolExecution> {
  try { return normalizeToolExecution(await dispatchTool(input), input.name); }
  catch (error) { return failedTool(error, "tool_execution_failed", { toolName: input.name }); }
}

async function dispatchTool(input: ExecuteInput): Promise<ToolExecution> {
  const { name, arguments: args, lookup, host, dataDir, browserNames } = input;
  if (name === "execute_javascript") {
    try {
      if ("code" in args || typeof args.filename !== "string" || !/\.(?:js|mjs|cjs)$/.test(args.filename)) {
        return failedTool("请先用 script_patch 保存 JavaScript 文件，再传 filename 执行。", "invalid_arguments");
      }
      if (!host) return failedTool("浏览器未连接", "browser_unavailable");
      const script = await readScript(dataDir, args.filename);
      return externalResult(await host.execute(name, { code: script.code, ...(args.tabId !== undefined ? { tabId: args.tabId } : {}) }));
    } catch (error) {
      return failedTool(error);
    }
  }
  if (name === "library") {
    try {
      if (args.action === "list") return result(JSON.stringify({ ok: true, items: listItems(dataDir, typeof args.query === "string" ? args.query : undefined) }));
      if (args.action === "get") {
        const item = listItems(dataDir).find(item => item.id === args.id);
        return item ? result(JSON.stringify({ ok: true, item })) : failedTool("资料不存在", "file_not_found");
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
      return failedTool("未知资料操作", "invalid_arguments");
    } catch (error) {
      return failedTool(error);
    }
  }
  if (name === "finishTurn") {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    return text ? result(text, [{ type: "turn.reply", text }])
      : { ...failedTool(errorMessage("empty_finish_turn", "model"), "empty_finish_turn"), effects: [{ type: "queue.clear" }] };
  }
  if (name === "askUser") {
    const text = typeof args.question === "string" ? args.question.trim() : "";
    if (!text) return { ...failedTool(errorMessage("empty_ask_user", "model"), "empty_ask_user"), effects: [{ type: "queue.clear" }] };
    const question = questionWithChoices(text, asStringArray(args.choice));
    return result(question, [{ type: "turn.ask", question }]);
  }
  if (name === "submitGoal") {
    if (!input.conversationId || !input.goalContext) return failedTool("目标工具缺少会话上下文。", "invalid_arguments");
    try {
      const update = prepareGoalUpdate(dataDir, input.conversationId, input.goalContext, args);
      return result(JSON.stringify({ ok: true, record: update.record, currentGoalId: update.currentGoalId }),
        [{ type: "goal.upsert", ...update }]);
    } catch (error) {
      return failedTool(error, "invalid_arguments");
    }
  }
  if (name === "notes.write") {
    const key = String(args.key ?? "").trim();
    const value = String(args.value ?? "");
    return key ? result(`notes[${key}]=${value}`, [{ type: "note.write", key, value }]) : failedTool("key 空着", "invalid_arguments");
  }
  if (name === "notes.delete") {
    const key = String(args.key ?? "").trim();
    return key ? result(`deleted notes[${key}]`, [{ type: "note.delete", key }]) : failedTool("key 空着", "invalid_arguments");
  }
  if (name === "catalog.add") {
    const names = [...new Set(asStringArray(args.names))];
    const added = names.filter((id) => lookup.knownTools.includes(id) && !lookup.enabledTools.includes(id));
    const alreadyEnabled = names.filter((id) => lookup.enabledTools.includes(id));
    const unknown = names.filter((id) => !lookup.knownTools.includes(id) && !lookup.enabledTools.includes(id));
    return result(JSON.stringify({ ok: unknown.length === 0, ...(unknown.length ? { faultCode: "unknown_tool" } : {}), added, alreadyEnabled, unknown }),
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
    if (!input.queryContext) return failedTool("query_agent_unavailable", "query_failed");
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
      ...(!queried.ok || !bounded ? { faultCode: queried.faultCode ?? "query_failed" } : {}),
      sumId: query.sumId, module: query.module, records: references,
      ...(query.nextCursor ? { nextCursor: query.nextCursor } : {}), detail: query.detail }),
      [{ type: "query.set", query }]);
  }
  if ((LOCAL_TOOL_NAMES as readonly string[]).includes(name)) {
    if (!input.conversationId) return failedTool("本地工具缺少会话标识", "invalid_arguments");
    return externalResult(await runLocalTool(name, hostArgs(args), dataDir, input.conversationId));
  }
  if ((SERVICE_TOOL_NAMES as readonly string[]).includes(name)) {
    return externalResult(await runServiceTool(dataDir, name, hostArgs(args), input.signal));
  }
  if (browserNames.includes(name)) {
    if (!host) return failedTool(`${name} 没有浏览器桥`, "browser_unavailable");
    return externalResult(await host.execute(name, hostArgs(args)));
  }
  return failedTool(`${name} 未接`, "unknown_tool");
}
