import { prepareGoalUpdate, type GoalContext } from "../runtime/goals.ts";
import { errorMessage } from "../../shared/errors.ts";
import type { QueryModule, QueryResult } from "../agents/query/types.ts";
import type { QueryRecord, QueryEvidence } from "../context/projections/queries.ts";
import type { ToolEffect, ToolExecution } from "./effects.ts";
import type { BrowserHost, CurrentPage, ToolArguments } from "../types.ts";
import { SERVICE_TOOL_NAMES, runServiceTool } from "./service-tools.ts";
import { STREAM_TOOL_NAMES, runStreamTool } from "./stream-tools.ts";
import { IMAGE_TOOL_NAMES, runImageTool } from "./image-crop.ts";
import { loadAssets, textFlavor } from "../assets/catalog.ts";
import { admitText } from "../admission.ts";
import { LOCAL_TOOL_NAMES, runLocalTool } from "./local-tools.ts";
import { COMPOUND_TOOL_NAMES, runCompoundTool } from "./compound-tools.ts";
import { JOB_TOOL_NAMES, runJobTool, withJobHeartbeat, jobScope } from "./job-registry.ts";
import { loadSkillManifest, skillCatalog } from "../skills/loader.ts";
import { listItems, saveItem, deleteItem } from "../library/store.ts";
import { readScript } from "../scripts/store.ts";
import { failedTool, normalizeToolExecution } from "./result.ts";
import { allocateRecordId } from "../runtime/ids.ts";
import { join } from "node:path";
import { loadFullReturn, paths } from "../runtime/store.ts";
import { loadContextRecord } from "../runtime/records.ts";
import { lineNumberAt, linesOf, wrapCachedText } from "../runtime/cache-lines.ts";
import { existsSync, readFileSync } from "node:fs";
import { runtimeConfig } from "../config/runtime.ts";

const questionWithChoices = (question: string, choice: string[]): string =>
  choice.length === 0 ? question : `${question}\n选项：${choice.join(" / ")}`;

const repoRoot = join(import.meta.dir, "../..");

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
  delete extra.execution;
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
  queryContext?: (args: {sumId: string; module: QueryModule; intent: string}) => Promise<QueryResult>;
  lookup: {
    unusedTools: string[];
    knownTools: string[];
    enabledTools: string[];
  };
  pageObservationIds?: string[];
  defaultTabId?: number | null;
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
        return failedTool("请先保存 JavaScript 文件到 scripts/，再传 filename 执行。", "invalid_arguments");
      }
      if (!host) return failedTool("浏览器未连接", "browser_unavailable");
      const script = await readScript(dataDir, args.filename);
      const payload = { code: script.code, ...(args.tabId !== undefined ? { tabId: args.tabId } : {}) };
      if (args.heartbeatSec !== undefined) {
        if (!input.conversationId) return failedTool("execute_javascript 心跳缺少会话标识", "invalid_arguments");
        const executed = await withJobHeartbeat({
          dataDir,
          scope: jobScope(dataDir, input.conversationId),
          toolName: name,
          heartbeatSec: args.heartbeatSec,
          parentSignal: input.signal,
          start: async (runSignal) => {
            const launch = host.executeTracked
              ? host.executeTracked(name, payload)
              : { id: "", result: host.execute(name, payload) };
            const onAbort = () => { if (launch.id && host.abortById) host.abortById(launch.id); };
            runSignal?.addEventListener("abort", onAbort, { once: true });
            try { return { ...(await launch.result) } as Record<string, unknown>; }
            finally { runSignal?.removeEventListener("abort", onAbort); }
          },
        });
        return externalResult(executed);
      }
      return externalResult(await host.execute(name, payload));
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
  if (name === "checkContinue") {
    const cont = args.cont === true || args.cont === "true";
    return result(JSON.stringify({ ok: true, cont }), cont ? [] : [{ type: "turn.reply", text: "已按 checkContinue 中断本 turn。" }]);
  }
  if (name === "reportProgress") {
    const text = String(args.text ?? "").trim();
    if (!text) return failedTool("reportProgress 需要非空 text", "invalid_arguments");
    return result(JSON.stringify({ ok: true, text }));
  }
  if (name === "finishTurn") {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text) return { ...failedTool(errorMessage("empty_finish_turn", "model"), "empty_finish_turn"), effects: [{ type: "queue.clear" }] };
    return result(text, [{ type: "turn.reply", text }]);
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
  if (name === "reflect.write") {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text) return failedTool("reflect.write 的 text 为空", "invalid_arguments", { toolName: name });
    if (!input.conversationId) return failedTool("reflect.write 缺少会话标识", "invalid_arguments", { toolName: name });
    const focus = typeof args.focus === "string" && args.focus.trim() ? args.focus.trim() : undefined;
    const replaceId = typeof args.id === "string" && args.id.trim() ? args.id.trim() : undefined;
    const id = replaceId ?? allocateRecordId(dataDir, input.conversationId, "reflect");
    return result(JSON.stringify({ ok: true, id, text, ...(focus ? { focus } : {}) }),
      [{ type: "reflect.write", id, text, ...(focus ? { focus } : {}), ...(replaceId ? { replace: true } : {}) }]);
  }
  if (name === "reflect.delete") {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!/^rf_[0-9]{2,}$/.test(id)) return failedTool("id 必须是 rf_ 编号", "invalid_arguments", { toolName: name });
    return result(JSON.stringify({ ok: true, id, deleted: true }), [{ type: "reflect.delete", id }]);
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
  if (name === "page.clear_result") {
    const pageId = String(args.pageId ?? "").trim();
    if (!pageId) return failedTool("pageId 空着", "invalid_arguments");
    if (input.pageObservationIds && !input.pageObservationIds.includes(pageId)) {
      return failedTool(`没有观察 ${pageId}`, "invalid_arguments");
    }
    return result(JSON.stringify({ ok: true, pageId, cleared: true }),
      [{ type: "page.clear_result", pageId }]);
  }
  if (name === "checklist.set") {
    const rawItems = Array.isArray(args.items) ? args.items : [];
    const items = rawItems.map((item: unknown) => {
      const row = (item ?? {}) as Record<string, unknown>;
      const status = row.status === "doing" || row.status === "done" || row.status === "todo" ? row.status : "todo";
      return { text: String(row.text ?? ""), status: status as "todo" | "doing" | "done" };
    }).filter((row) => row.text.trim());
    if (!items.length) return failedTool("checklist.set 需要非空 items", "invalid_arguments");
    const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined;
    return result(JSON.stringify({ ok: true, count: items.length, ...(title ? { title } : {}) }),
      [{ type: "checklist.set", ...(title ? { title } : {}), items }]);
  }
  if (name === "checklist.update") {
    const rawItems = Array.isArray(args.items) ? args.items : [];
    const updates = rawItems.map((item: unknown) => {
      const row = (item ?? {}) as Record<string, unknown>;
      const index = Number(row.index);
      const patch: { index: number; status?: "todo" | "doing" | "done"; text?: string } = { index };
      if (row.status === "todo" || row.status === "doing" || row.status === "done") patch.status = row.status;
      if (typeof row.text === "string" && row.text.trim()) patch.text = row.text.trim();
      return patch;
    }).filter((row) => Number.isInteger(row.index) && row.index >= 0 && (row.status !== undefined || row.text !== undefined));
    if (!updates.length) return failedTool("checklist.update 需要 index 以及 status 或 text", "invalid_arguments");
    return result(JSON.stringify({ ok: true, updated: updates.length }),
      [{ type: "checklist.update", items: updates }]);
  }
  if (name === "tab.context") {
    const action = String(args.action ?? "get");
    if (action === "set") {
      const tabId = Number(args.tabId);
      if (!Number.isInteger(tabId) || tabId < 0) return failedTool("tab.context set 需要 tabId", "invalid_arguments");
      return result(JSON.stringify({ ok: true, action, tabId }), [{ type: "tab.context.set", tabId }]);
    }
    if (action === "clear") {
      return result(JSON.stringify({ ok: true, action }), [{ type: "tab.context.clear" }]);
    }
    return result(JSON.stringify({
      ok: true,
      action: "get",
      tabId: input.defaultTabId ?? null,
    }));
  }
  if (name === "evidence.search") {
    if (!input.conversationId) return failedTool("evidence.search 缺少会话标识", "invalid_arguments");
    const windows = Array.isArray(args.windows) ? args.windows as Record<string, unknown>[] : [];
    if (windows.length < 1 || windows.length > 8) return failedTool("windows 必须是 1..8 个窗口", "invalid_arguments");
    const searchOne = (win: Record<string, unknown>): Record<string, unknown> => {
      const keyword = typeof win.keyword === "string" ? win.keyword : "";
      const callId = typeof win.callId === "string" ? win.callId.trim() : "";
      const pageId = typeof win.pageId === "string" ? win.pageId.trim() : "";
      if (!callId && !pageId) return { ok: false, faultCode: "invalid_arguments", detail: "callId 或 pageId 必须提供一个" };
      if (callId && pageId) return { ok: false, faultCode: "invalid_arguments", detail: "callId 与 pageId 只能提供一个" };
      const rawStart = win.startLine;
      const startLine = rawStart == null || rawStart === "" ? null : Number(rawStart);
      const hasLineMode = startLine !== null;
      if (hasLineMode && keyword.trim()) return { ok: false, faultCode: "invalid_arguments", detail: "keyword 与 startLine 互斥：检索或按行读取二选一" };
      if (!hasLineMode && !keyword.trim()) return { ok: false, faultCode: "invalid_arguments", detail: "必须提供 keyword 或 startLine" };
      if (startLine !== null && (!Number.isInteger(startLine) || startLine < 1)) return { ok: false, faultCode: "invalid_arguments", detail: "startLine 必须是 ≥1 的整数" };
      const limits = runtimeConfig.results;
      const rawWindow = Number(win.contextChars ?? limits.searchContextChars);
      const contextChars = Number.isFinite(rawWindow)
        ? Math.min(limits.searchMaxContextChars, Math.max(20, Math.floor(rawWindow)))
        : limits.searchContextChars;
      const lineWidth = limits.lineWidth;
      let haystack = "";
      let source = "";
      let path = "";
      if (callId) {
        path = join(paths(dataDir, input.conversationId!).returns, `${callId}.txt`);
        haystack = loadFullReturn(dataDir, input.conversationId!, callId) ?? "";
        source = `call:${callId}`;
      } else {
        const textPath = join(dataDir, "conversations", input.conversationId!, "context-records", "pageObservation", `${pageId}.txt`);
        const jsonPath = join(dataDir, "conversations", input.conversationId!, "context-records", "pageObservation", `${pageId}.json`);
        path = textPath;
        if (existsSync(textPath)) {
          haystack = readFileSync(textPath, "utf8");
        } else {
          path = jsonPath;
          const raw = loadContextRecord(dataDir, input.conversationId!, "pageObservation", pageId);
          if (raw) {
            try {
              const record = JSON.parse(raw) as { result?: unknown };
              const body = typeof record.result === "string" ? record.result : JSON.stringify(record.result ?? null);
              haystack = wrapCachedText(body);
            } catch {
              haystack = wrapCachedText(raw);
            }
          }
        }
        source = `page:${pageId}`;
      }
      const lines = linesOf(haystack);
      const totalLines = lines.length;
      const totalChars = haystack.length;
      if (!haystack) {
        return {
          ok: false,
          faultCode: "file_not_found",
          source,
          path,
          keyword,
          lineWidth,
          detail: "未找到已缓存的原文，确认 callId/pageId 是否来自本会话超量结果",
        };
      }
      if (hasLineMode) {
        const from = startLine!;
        if (from > totalLines) {
          return {
            ok: false,
            faultCode: "not_found",
            source,
            path,
            mode: "lines",
            lineWidth,
            totalLines,
            totalChars,
            startLine: from,
            detail: `startLine 超出总行数 ${totalLines}`,
          };
        }
        let used = 0;
        let to = from - 1;
        while (to < totalLines) {
          const next = lines[to]!.length;
          if (to >= from && used + next > contextChars) break;
          used += next;
          to += 1;
          if (used >= contextChars) break;
        }
        if (to < from) to = from;
        const slice = lines.slice(from - 1, to).map((text, index) => ({ line: from + index, text }));
        return {
          ok: true,
          source,
          path,
          mode: "lines",
          lineWidth,
          totalLines,
          totalChars,
          startLine: from,
          endLine: to,
          contextChars,
          lines: slice,
        };
      }
      const matches: { offset: number; lineStart: number; lineEnd: number; before: string; hit: string; after: string }[] = [];
      const lowerHay = haystack.toLowerCase();
      const needle = keyword.toLowerCase();
      let from = 0;
      while (matches.length < limits.searchMaxMatches) {
        const at = lowerHay.indexOf(needle, from);
        if (at === -1) break;
        const before = haystack.slice(Math.max(0, at - contextChars), at);
        const hit = haystack.slice(at, at + keyword.length);
        const after = haystack.slice(at + keyword.length, at + keyword.length + contextChars);
        const lineStart = lineNumberAt(haystack, at);
        const lineEnd = lineNumberAt(haystack, at + hit.length - 1);
        matches.push({ offset: at, lineStart, lineEnd, before, hit, after });
        from = at + Math.max(1, keyword.length);
      }
      return {
        ok: matches.length > 0,
        source,
        path,
        mode: "search",
        keyword,
        contextChars,
        lineWidth,
        totalLines,
        totalChars,
        matchCount: matches.length,
        matches,
        ...(matches.length ? {} : { faultCode: "not_found", detail: "关键字未命中缓存原文" }),
      };
    };
    const results = windows.map(searchOne);
    return result(JSON.stringify({ ok: results.every((row) => row.ok), results }));
  }
  if (name === "skill.list") {
    const tag = typeof args.tag === "string" && args.tag.trim() ? args.tag.trim() : undefined;
    return result(JSON.stringify({ ok: true, skills: skillCatalog(repoRoot, tag) }));
  }
  if (name === "skill.load") {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!id) return failedTool("skill.load 的 id 为空", "invalid_arguments", { toolName: name });
    if (loadSkillManifest(repoRoot).residentSkillIds.includes(id)) {
      return failedTool(`技能 ${id} 为常驻技能，正文已在 <systemSkill>`, "invalid_arguments", { toolName: name });
    }
    const hit = skillCatalog(repoRoot).find(item => item.id === id);
    if (!hit) return failedTool(`未知技能 ${id}`, "invalid_arguments", { toolName: name });
    return result(JSON.stringify({ ok: true, id: hit.id, tags: hit.tags, purpose: hit.purpose }), [{ type: "skill.load", id }]);
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
  if (name === "memory.update") {
    const memoryId = String(args.memoryId ?? "").trim();
    const text = String(args.text ?? "").trim();
    if (!/^(?:mm|lm)_[0-9]{2,}$/.test(memoryId)) {
      return failedTool("memoryId 必须是 mm_ 或 lm_ 记忆编号", "invalid_arguments", { toolName: name });
    }
    if (!text) return failedTool("text 不能为空", "invalid_arguments", { toolName: name });
    if (!input.conversationId) return failedTool("memory.update 缺少会话标识", "invalid_arguments");
    return result(JSON.stringify({
      ok: true,
      memoryId,
      layer: memoryId.startsWith("lm_") ? "project" : "conversation",
      text,
    }), [{ type: "memory.update", memoryId, text }]);
  }
  if (name === "memory.delete") {
    const memoryId = String(args.memoryId ?? "").trim();
    if (!/^(?:mm|lm)_[0-9]{2,}$/.test(memoryId)) {
      return failedTool("memoryId 必须是 mm_ 或 lm_ 记忆编号", "invalid_arguments", { toolName: name });
    }
    return result(JSON.stringify({
      ok: true,
      memoryId,
      layer: memoryId.startsWith("lm_") ? "project" : "conversation",
    }), [{ type: "memory.delete", memoryId }]);
  }
  if (name === "context.query") {
    if (!input.queryContext) return failedTool("query_agent_unavailable", "query_failed");
    const queried = await input.queryContext({ sumId: String(args.sumId), module: args.module as QueryModule,
      intent: String(args.intent) });
    if (queried.status === "cancelled") return result(JSON.stringify({ ok: false, status: "cancelled" }));
    const status: QueryEvidence["status"] = queried.status === "not_found" || queried.status === "error" ? queried.status : "complete";
    const query = { sumId: queried.sumId, module: queried.module, intent: queried.intent,
      status,
      records: queried.records as QueryRecord[],
      detail: queried.detail };
    // Full records go to the archive + <currentQuery>; toolIO projection keeps a pointer only.
    return result(JSON.stringify({
      ok: queried.ok,
      status: query.status,
      ...(queried.ok ? {} : { faultCode: queried.faultCode ?? "query_failed" }),
      sumId: query.sumId,
      module: query.module,
      intent: query.intent,
      records: query.records,
      detail: query.detail,
    }), [{ type: "query.set", query }]);
  }
  if ((JOB_TOOL_NAMES as readonly string[]).includes(name)) {
    if (!input.conversationId) return failedTool("job 工具缺少会话标识", "invalid_arguments");
    return externalResult(await runJobTool(name, hostArgs(args), jobScope(dataDir, input.conversationId)));
  }
  if ((STREAM_TOOL_NAMES as readonly string[]).includes(name)) {
    return externalResult(await runStreamTool(name, hostArgs(args), host, dataDir, input.conversationId));
  }
  if ((IMAGE_TOOL_NAMES as readonly string[]).includes(name)) {
    return externalResult(await runImageTool(name, hostArgs(args), host, dataDir, input.conversationId));
  }
  if (name === "asset.list") {
    if (!input.conversationId) return failedTool("asset.list 缺少会话标识", "invalid_arguments");
    const assets = loadAssets(dataDir, input.conversationId).filter((item) => {
      if (typeof args.kind === "string" && args.kind && item.kind !== args.kind) return false;
      if (typeof args.name === "string" && args.name.trim() && !item.name.includes(args.name.trim())) return false;
      return true;
    });
    return result(JSON.stringify({ ok: true, assets }));
  }
  if (name === "asset.read") {
    if (!input.conversationId) return failedTool("asset.read 缺少会话标识", "invalid_arguments");
    const assetId = String(args.assetId ?? "").trim();
    const asset = loadAssets(dataDir, input.conversationId).find((item) => item.assetId === assetId);
    if (!asset) return failedTool(`找不到资产 ${assetId}`, "file_not_found");
    if (asset.kind === "image") {
      const imageId = asset.name.replace(/\.[^.]+$/, "");
      const rect = { x: args.x, y: args.y, width: args.width, height: args.height };
      if (Object.values(rect).every((n) => typeof n === "number")) {
        return externalResult(await runImageTool("image.crop", { imageId, ...rect }, host, dataDir, input.conversationId));
      }
      return result(JSON.stringify({ ok: true, asset, fetchHint: "要像素请传 x/y/width/height 走 image.crop，或 capture_page(mode=element|rect)" }));
    }
    if (!asset.source.callId) {
      const full = readFileSync(join(dataDir, "conversations", input.conversationId, asset.path), "utf8");
      const window = args.startLine
        ? full.split(/\r?\n/).slice(Number(args.startLine) - 1, Number(args.startLine) + 3).join("\n")
        : typeof args.keyword === "string" && args.keyword
          ? full.slice(Math.max(0, full.indexOf(args.keyword) - 200), Math.max(0, full.indexOf(args.keyword) - 200) + 400)
          : full.slice(0, runtimeConfig.results.inlineChars);
      const admitted = admitText(window, { path: asset.path, name: asset.name });
      return admitted.mode === "inline"
        ? result(JSON.stringify({ ok: true, asset, window: admitted.text, flavor: textFlavor(window) }))
        : result(JSON.stringify({ ok: true, asset, ...((admitted as { payload?: Record<string, unknown> }).payload ?? {}), flavor: textFlavor(window) }));
    }
    return await executeTool({
      ...input,
      name: "evidence.search",
      arguments: {
        reason: typeof args.reason === "string" ? args.reason : "asset.read",
        windows: [{
          callId: asset.source.callId ?? asset.name.replace(/\.txt$/, ""),
          ...(typeof args.keyword === "string" && args.keyword ? { keyword: args.keyword } : {}),
          ...(typeof args.startLine === "number" ? { startLine: args.startLine } : { keyword: "" }),
        }],
      },
    });
  }
  if ((LOCAL_TOOL_NAMES as readonly string[]).includes(name)) {
    if (!input.conversationId) return failedTool("本地工具缺少会话标识", "invalid_arguments");
    return externalResult(await runLocalTool(name, hostArgs(args), dataDir, input.conversationId));
  }
  if ((SERVICE_TOOL_NAMES as readonly string[]).includes(name)) {
    return externalResult(await runServiceTool(dataDir, name, hostArgs(args), input.signal, input.conversationId));
  }
  if ((COMPOUND_TOOL_NAMES as readonly string[]).includes(name)) {
    if (!host) return failedTool(`${name} 没有浏览器桥`, "browser_unavailable");
    const compoundArgs = hostArgs(input.arguments);
    if ((compoundArgs.tabId === undefined || compoundArgs.tabId === null) && Number.isInteger(input.defaultTabId) && input.defaultTabId! >= 0) {
      compoundArgs.tabId = input.defaultTabId;
    }
    return externalResult(await runCompoundTool(name, compoundArgs, host));
  }
  if (browserNames.includes(name)) {
    if (!host) return failedTool(`${name} 没有浏览器桥`, "browser_unavailable");
    const args = hostArgs(input.arguments);
    if ((args.tabId === undefined || args.tabId === null) && Number.isInteger(input.defaultTabId) && input.defaultTabId! >= 0) {
      args.tabId = input.defaultTabId;
    }
    return externalResult(await host.execute(name, args));
  }
  return failedTool(`${name} 未接`, "unknown_tool");
}
