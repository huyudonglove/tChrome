import { errorMessage } from "../../shared/errors.ts";
import { errorDetail } from "../../shared/error-details.ts";
import type { QueryModule, QueryResult } from "../agents/query/types.ts";
import type { ToolEffect, ToolExecution } from "./effects.ts";
import type { BrowserHost, ChatTool, CurrentPage, Provider, ToolArguments } from "../types.ts";
import { createTaskPacket, runSubagentDag, createSubagentExecutor, type SubagentCapability, type TaskPacket } from "../agents/subagent/index.ts";
import { SERVICE_TOOL_NAMES, runServiceTool } from "./service-tools.ts";
import { STREAM_TOOL_NAMES, runStreamTool } from "./stream-tools.ts";
import { IMAGE_TOOL_NAMES, runImageTool } from "./image-crop.ts";
import { loadAssets } from "../assets/catalog.ts";
import { retrievalWindowChars } from "../admission.ts";
import { LOCAL_TOOL_NAMES, runLocalTool } from "./local-tools.ts";
import { COMPOUND_TOOL_NAMES, runCompoundTool } from "./compound-tools.ts";
import { JOB_TOOL_NAMES, runJobTool, withJobHeartbeat, jobScope } from "./job-registry.ts";
import { loadSkillManifest, skillCatalog, skillCatalogPage } from "../skills/loader.ts";
import { listItems, saveItem, deleteItem } from "../library/store.ts";
import { readScript } from "../scripts/store.ts";
import { failedTool, normalizeToolExecution } from "./result.ts";
import { allocateRecordId } from "../runtime/ids.ts";
import { join } from "node:path";
import { loadLedger, loadFullReturn, loadReturnBlockIndex, saveReturnBlockIndex, paths } from "../runtime/store.ts";
import { loadContextRecord } from "../runtime/records.ts";
import { buildBlockIndex, readBlock, searchBlocks, type BlockIndex } from "../evidence/index.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const retrieveEvidenceBlock = (index: BlockIndex, win: Record<string, unknown>, source: string, path: string): Record<string, unknown> => {
  if (win.keyword !== undefined) {
    const all = searchBlocks(index, win.keyword as string);
    const offset = (win.offset as number | undefined) ?? 0;
    const matches: typeof all = [];
    let chars = 0;
    for (const hit of all.slice(offset)) {
      const size = JSON.stringify(hit).length;
      if (matches.length > 0 && chars + size > retrievalWindowChars()) break;
      matches.push(hit);
      chars += size;
    }
    const nextOffset = offset + matches.length;
    return {
      ok: matches.length > 0, kind: "search", source, path, keyword: win.keyword,
      totalMatches: all.length, offset, matches,
      ...(nextOffset < all.length ? { nextOffset } : {}),
      ...(matches.length ? {} : { faultCode: "not_found", detail: "没有匹配的原文块" }),
    };
  }
  const blockId = win.blockId === undefined ? index.rootId : win.blockId as string;
  const block = readBlock(index, blockId);
  return block
    ? { ok: true, path, ...block, ...(block.kind === "content" ? { location: block.source } : {}), source }
    : { ok: false, source, path, blockId, faultCode: "not_found", detail: "未找到原文块" };
};

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
  delete extra.keepInCalls;
  return extra;
};

export type ExecuteInput = {
  name: string;
  arguments: ToolArguments;
  dataDir: string;
  conversationId?: string;
  browserNames: string[];
  host?: BrowserHost;
  provider?: Provider;
  repoRoot?: string;
  subagentTools?: readonly ChatTool[];
  subagentToolCapabilities?: Readonly<Record<string, readonly SubagentCapability[]>>;
  signal?: AbortSignal;
  queryContext?: (args: {sumId?: string; loopId?: string; module: QueryModule; intent: string; file?: string}) => Promise<QueryResult>;
  compressContext?: () => Promise<{
    status: "completed" | "stopped" | "noop";
    committedLoopIds: string[];
    failedLoopIds?: string[];
    totalLoops: number;
    windowChars?: { before: number | null; after: number | null };
  }>;
  lookup: {
    unusedTools: string[];
    knownTools: string[];
    enabledTools: string[];
    protectedTools?: string[];
  };
  observationIds?: string[];
  defaultTabId?: number | null;
};

// admitted=true：取回型工具主动按门禁预算裁剪过（见 ToolExecution 注释），
// 门禁编排处见到该标记应直接内联，不再二次外置成指针。
const result = (text: string, effects: ToolEffect[] = [], admitted?: boolean): ToolExecution => ({
  text, effects, ...(admitted ? { admitted } : {}),
});

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
  if (name === "delegate_subagent") {
    if (!input.provider) return failedTool("Subagent provider is missing", "provider_unavailable");
    const packets = (args.packets as Parameters<typeof createTaskPacket>[0][]).map(createTaskPacket);
    const executor = createSubagentExecutor({
      provider: input.provider,
      tools: input.subagentTools,
      toolCapabilities: input.subagentToolCapabilities,
      maxSteps: args.maxSteps as number | undefined,
      executeTool: async call => {
        const execution = await executeTool({ ...input, name: call.name, arguments: call.arguments, signal: call.signal });
        return { text: execution.text };
      },
    }, input.signal);
    const dag = await runSubagentDag(packets, executor, { maxParallel: args.maxParallel as number | undefined });
    // ok 描述「整次委派是否全部达成」，必须按真实 DAG 结果算：原先无条件写 true，
    // 即使所有 packet 都失败也对外报成功，调用方无法据此判断。
    const outcomes = Object.values(dag.results);
    const success = outcomes.filter((row) => row.status === "success").length;
    const failed = outcomes.filter((row) => row.status === "failed").length;
    const blocked = outcomes.filter((row) => row.status === "blocked").length;
    const ok = packets.length > 0 && success === packets.length;
    // 未全部成功时带专用故障码：否则统一外壳会把它报成笼统的「工具执行失败」，
    // 调用方看不出只是部分 packet 未完成；逐项详情仍在 results 与 total/success/failed/blocked 里。
    const faultCode = ok ? null : success === 0 ? "subagent_failed" : "subagent_partial_failure";
    return result(JSON.stringify({ ok, ...dag, total: packets.length, success, failed, blocked, ...(faultCode ? { faultCode } : {}) }));
  }
  if (name === "execute_javascript") {
    try {
      if ("code" in args || typeof args.filename !== "string" || !/\.(?:js|mjs|cjs)$/.test(args.filename)) {
        return failedTool(errorDetail("exec_js_need_script"), "invalid_arguments");
      }
      if (!host) return failedTool(errorDetail("browser_not_connected"), "browser_unavailable");
      const script = await readScript(dataDir, args.filename);
      const payload = { code: script.code, ...(args.tabId !== undefined ? { tabId: args.tabId } : {}) };
      if (args.heartbeatSec !== undefined) {
        if (!input.conversationId) return failedTool(errorDetail("exec_js_missing_session"), "invalid_arguments");
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
        return item ? result(JSON.stringify({ ok: true, item })) : failedTool(errorDetail("library_missing"), "file_not_found");
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
      return failedTool(errorDetail("library_unknown_action"), "invalid_arguments");
    } catch (error) {
      return failedTool(error);
    }
  }
  if (name === "checkContinue") {
    const cont = args.cont === true || args.cont === "true";
    return result(JSON.stringify({ ok: true, cont }), cont ? [] : [{ type: "turn.reply", text: "已按 checkContinue 中断本 turn。" }]);
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
  if (name === "reflect_write") {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text) return failedTool(errorDetail("reflect_empty_text"), "invalid_arguments", { toolName: name });
    if (!input.conversationId) return failedTool(errorDetail("reflect_missing_session"), "invalid_arguments", { toolName: name });
    const focus = typeof args.focus === "string" && args.focus.trim() ? args.focus.trim() : undefined;
    const replaceId = typeof args.id === "string" && args.id.trim() ? args.id.trim() : undefined;
    const id = replaceId ?? allocateRecordId(dataDir, input.conversationId, "reflect");
    return result(JSON.stringify({ ok: true, id, text, ...(focus ? { focus } : {}) }),
      [{ type: "reflect_write", id, text, ...(focus ? { focus } : {}), ...(replaceId ? { replace: true } : {}) }]);
  }
  if (name === "reflect_delete") {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!/^rf_[0-9]{2,}$/.test(id)) return failedTool(errorDetail("reflect_bad_id"), "invalid_arguments", { toolName: name });
    return result(JSON.stringify({ ok: true, id, deleted: true }), [{ type: "reflect_delete", id }]);
  }
  if (name === "observation_write") {
    const observationType = String(args.type ?? "").trim();
    if (!observationType) return failedTool(errorDetail("observation_type_empty"), "invalid_arguments");
    if (args.result === undefined || args.result === null) return failedTool(errorDetail("observation_result_empty"), "invalid_arguments");
    const tabId = typeof args.tabId === "number" && Number.isFinite(args.tabId) && args.tabId > 0 ? args.tabId : undefined;
    const validForTurns = typeof args.validForTurns === "number" && Number.isFinite(args.validForTurns) && args.validForTurns >= 1
      ? Math.floor(args.validForTurns)
      : undefined;
    // refresh points at an existing observation id so the record is refreshed in place (new
    // writtenTurn/validUntilTurn) instead of piling up a second copy of the same conclusion.
    const refresh = typeof args.refresh === "string" && /^page_[0-9]{2,}$/.test(args.refresh.trim())
      ? args.refresh.trim()
      : undefined;
    return result(JSON.stringify({ ok: true, type: observationType, ...(tabId !== undefined ? { tabId } : {}) }),
      [{ type: "observation_write", observationType, result: args.result, ...(tabId !== undefined ? { tabId } : {}), ...(validForTurns !== undefined ? { validForTurns } : {}), ...(refresh !== undefined ? { refresh } : {}) }]);
  }
  if (name === "tabs_current") {
    if (!host?.readCurrentTabs) return failedTool(errorDetail("browser_not_connected"), "browser_unavailable");
    const tabs = await host.readCurrentTabs();
    return result(JSON.stringify(tabs));
  }
  if (name === "page_clear_result") {
    const pageId = String(args.pageId ?? "").trim();
    if (!pageId) return failedTool("pageId 空着", "invalid_arguments");
    if (input.observationIds && !input.observationIds.includes(pageId)) {
      return failedTool(errorDetail("page_clear_missing_obs", { pageId }), "invalid_arguments");
    }
    return result(JSON.stringify({ ok: true, pageId, cleared: true }),
      [{ type: "page_clear_result", pageId }]);
  }
  if (name === "task_set") {
    const rawItems = Array.isArray(args.items) ? args.items : [];
    const items = rawItems.map((item: unknown) => {
      const row = (item ?? {}) as Record<string, unknown>;
      const status: "todo" | "doing" | "done" | undefined =
        row.status === "doing" || row.status === "done" || row.status === "todo" ? row.status : undefined;
      return {
        text: String(row.text ?? ""),
        ...(status ? { status } : {}),
        ...(typeof row.expectedEffect === "string" && row.expectedEffect.trim() ? { expectedEffect: row.expectedEffect.trim() } : {}),
        ...(typeof row.verification === "string" && row.verification.trim() ? { verification: row.verification.trim() } : {}),
      };
    }).filter((row) => row.text.trim());
    if (!items.length) return failedTool(errorDetail("task_set_empty_items"), "invalid_arguments");
    const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined;
    return result(JSON.stringify({ ok: true, count: items.length, ...(title ? { title } : {}) }),
      [{ type: "task_set", ...(title ? { title } : {}), items }]);
  }
  if (name === "task_update") {
    const rawItems = Array.isArray(args.items) ? args.items : [];
    const updates = rawItems.map((item: unknown) => {
      const row = (item ?? {}) as Record<string, unknown>;
      const id = typeof row.id === "string" ? row.id.trim() : "";
      const patch: { id: string; status?: "todo" | "doing" | "done"; text?: string; expectedEffect?: string; verification?: string; blockedReason?: string; outcome?: string } = { id };
      if (row.status === "todo" || row.status === "doing" || row.status === "done") patch.status = row.status;
      if (typeof row.text === "string" && row.text.trim()) patch.text = row.text.trim();
      if (typeof row.expectedEffect === "string" && row.expectedEffect.trim()) patch.expectedEffect = row.expectedEffect.trim();
      if (typeof row.verification === "string" && row.verification.trim()) patch.verification = row.verification.trim();
      if (typeof row.blockedReason === "string" && row.blockedReason.trim()) patch.blockedReason = row.blockedReason.trim();
      if (typeof row.outcome === "string" && row.outcome.trim()) patch.outcome = row.outcome.trim();
      return patch;
    }).filter((row) => row.id && (row.status !== undefined || row.text !== undefined || row.expectedEffect !== undefined || row.verification !== undefined || row.blockedReason !== undefined || row.outcome !== undefined));
    if (!updates.length) return failedTool(errorDetail("task_update_patch"), "invalid_arguments");
    const taskId = typeof args.taskId === "string" && args.taskId.trim() ? args.taskId.trim() : undefined;
    if (!taskId) return failedTool("task_update 需要显式 taskId", "invalid_arguments");
    const hasBlocked = updates.some((row) => Boolean(row.blockedReason));
    return result(JSON.stringify({
      ok: true,
      updated: updates.length,
      ...(taskId ? { taskId } : {}),
      ...(hasBlocked ? { hint: "runtime: 任务步骤已记录 blockedReason。若确认原方案不可行或认知发生转折，建议调用 reflect_write 沉淀判断变化或放弃理由。" } : {}),
    }), [{ type: "task_update", ...(taskId ? { taskId } : {}), items: updates }]);
  }
  if (name === "task_complete") {
    const taskId = typeof args.taskId === "string" && args.taskId.trim() ? args.taskId.trim() : undefined;
    if (!taskId) return failedTool("task_complete 需要显式 taskId", "invalid_arguments");
    const reason = typeof args.reason === "string" && args.reason.trim() ? args.reason.trim() : undefined;
    return result(JSON.stringify({ ok: true, ...(taskId ? { taskId } : {}) }),
      [{ type: "task_complete", ...(taskId ? { taskId } : {}), ...(reason ? { reason } : {}) }]);
  }
  if (name === "tab_context") {
    const action = String(args.action ?? "get");
    if (action === "set") {
      const tabId = Number(args.tabId);
      if (!Number.isInteger(tabId) || tabId < 0) return failedTool(errorDetail("tab_context_set_tab"), "invalid_arguments");
      return result(JSON.stringify({ ok: true, action, tabId }), [{ type: "tab_context.set", tabId }]);
    }
    if (action === "clear") {
      return result(JSON.stringify({ ok: true, action }), [{ type: "tab_context.clear" }]);
    }
    return result(JSON.stringify({
      ok: true,
      action: "get",
      tabId: input.defaultTabId ?? null,
    }));
  }
  if (name === "evidence_search") {
    if (!input.conversationId) return failedTool(errorDetail("evidence_missing_session"), "invalid_arguments");
    const windows = Array.isArray(args.windows) ? args.windows : [];
    if (windows.length < 1 || windows.length > 8) return failedTool(errorDetail("evidence_windows_range"), "invalid_arguments");
    const searchOne = (value: unknown): Record<string, unknown> => {
      const invalid = (detail: string) => ({ ok: false, faultCode: "invalid_arguments", detail });
      if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("窗口必须是对象");
      const win = value as Record<string, unknown>;
      if (Object.keys(win).some(key => !["callId", "pageId", "blockId", "keyword", "offset"].includes(key))) return invalid("窗口仅支持 callId/pageId、blockId/keyword 和搜索 offset");
      const hasCall = win.callId !== undefined;
      const hasPage = win.pageId !== undefined;
      if (hasCall === hasPage) return invalid("callId 与 pageId 必须且只能提供一个");
      const id = hasCall ? win.callId : win.pageId;
      if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) return invalid("来源 ID 无效");
      const hasBlock = win.blockId !== undefined;
      const hasKeyword = win.keyword !== undefined;
      if (hasBlock && hasKeyword) return invalid("blockId 与 keyword 不能同时提供");
      if (hasBlock && (typeof win.blockId !== "string" || !win.blockId.trim())) return invalid("blockId 必须是非空字符串");
      if (hasKeyword && (typeof win.keyword !== "string" || !win.keyword.trim())) return invalid("keyword 必须是非空字符串");
      if (win.offset !== undefined && (!hasKeyword || typeof win.offset !== "number" || !Number.isSafeInteger(win.offset) || win.offset < 0)) return invalid("offset 仅用于关键词搜索，且必须是非负整数");
      const source = `${hasCall ? "call" : "page"}:${id}`;
      const path = hasCall
        ? join(paths(dataDir, input.conversationId!).returns, `${id}.txt`)
        : join(dataDir, "conversations", input.conversationId!, "context-records", "observation", `${id}.txt`);
      const indexPath = path.replace(/\.txt$/, ".index.json");
      let index: BlockIndex | null = hasCall
        ? loadReturnBlockIndex(dataDir, input.conversationId!, id)
        : existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) as BlockIndex : null;
      if (!index) {
        let full = hasCall ? loadFullReturn(dataDir, input.conversationId!, id) : null;
        if (!hasCall) {
          if (existsSync(path)) full = readFileSync(path, "utf8");
          else {
            const record = loadContextRecord(dataDir, input.conversationId!, "observation", id);
            if (record !== null) {
              const resultValue = (JSON.parse(record) as { result: unknown }).result;
              full = typeof resultValue === "string" ? resultValue : JSON.stringify(resultValue);
            }
          }
        }
        if (full === null || full === undefined) return { ok: false, source, path, faultCode: "file_not_found", detail: "未找到来源原文" };
        index = buildBlockIndex(full, { maxChars: retrievalWindowChars(), path });
        if (hasCall) saveReturnBlockIndex(dataDir, input.conversationId!, id, index);
        else {
          if (!existsSync(path)) writeFileSync(path, full);
          writeFileSync(indexPath, JSON.stringify(index));
        }
      }
      return retrieveEvidenceBlock(index, win, source, path);
    };
    const results = windows.map(searchOne);
    // 目录和原文块已由统一索引划分；取回时保留全部窗口和完整原文，不再次外置。
    return result(JSON.stringify({ ok: results.every(row => row.ok), results }), [], true);
  }
  if (name === "skill_list") {
    const keyword = typeof args.keyword === "string" && args.keyword.trim() ? args.keyword.trim() : undefined;
    const numArg = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;
    const page = skillCatalogPage(repoRoot, { keyword, offset: numArg(args.offset), limit: numArg(args.limit) });
    return result(JSON.stringify({ ok: true, ...page }));
  }
  if (name === "skill_load") {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!id) return failedTool(errorDetail("skill_load_empty_id"), "invalid_arguments", { toolName: name });
    if (loadSkillManifest(repoRoot).residentSkillIds.includes(id)) {
      return failedTool(errorDetail("skill_resident", { id }), "invalid_arguments", { toolName: name });
    }
    const hit = skillCatalog(repoRoot).find(item => item.id === id);
    if (!hit) return failedTool(errorDetail("skill_unknown", { id }), "invalid_arguments", { toolName: name });
    return result(JSON.stringify({ ok: true, id: hit.id, summary: hit.summary, purpose: hit.purpose }), [{ type: "skill_load", id }]);
  }
  if (name === "catalog_add") {
    const names = [...new Set(asStringArray(args.names))];
    const mode = args.mode === "remove" ? "remove" : "add";
    if (mode === "remove") {
      const protectedNames = lookup.protectedTools ?? [];
      const removed = names.filter((id) => lookup.enabledTools.includes(id) && !protectedNames.includes(id));
      const notLoaded = names.filter((id) => !lookup.enabledTools.includes(id) && !protectedNames.includes(id));
      const protectedKept = names.filter((id) => protectedNames.includes(id));
      return result(JSON.stringify({ ok: true, mode, removed, notLoaded, protectedKept }),
        removed.length ? [{ type: "tools.disable", names: removed }] : []);
    }
    const added = names.filter((id) => lookup.knownTools.includes(id) && !lookup.enabledTools.includes(id));
    const alreadyEnabled = names.filter((id) => lookup.enabledTools.includes(id));
    const unknown = names.filter((id) => !lookup.knownTools.includes(id) && !lookup.enabledTools.includes(id));
    return result(JSON.stringify({ ok: unknown.length === 0, ...(unknown.length ? { faultCode: "unknown_tool" } : {}), added, alreadyEnabled, unknown }),
      added.length ? [{ type: "tools.enable", names: added }] : []);
  }
  if (name === "list_browser_tools") {
    return result(JSON.stringify({ ok: true, tools: lookup.unusedTools }));
  }
  if (name === "memory_writeConversation") {
    const entries = asStringArray(args.conversationMemory).map((text) => ({
      layer: "conversation" as const, text,
    }));
    const effects: ToolEffect[] = entries.length ? [{ type: "memory.append", entries }] : [];
    return result(`落下 conversation=${entries.length} project=0`, effects);
  }
  if (name === "memory_writeProject") {
    const texts = asStringArray(args.projectMemory);
    const summaries = asStringArray(args.summary);
    if (summaries.length > 0 && summaries.length !== texts.length) {
      return failedTool(
        errorDetail("conflicting_params", { tool: name, fields: "summary 与 projectMemory" }),
        "invalid_arguments",
        { toolName: name },
      );
    }
    const scope = String(args.scope ?? "").trim();
    const entries = texts.map((text, index) => ({
      layer: "project" as const,
      text,
      ...(scope ? { scope } : {}),
      ...(summaries[index] ? { summary: summaries[index] } : {}),
    }));
    const effects: ToolEffect[] = entries.length ? [{ type: "memory.append", entries }] : [];
    const withSummary = entries.filter((entry) => entry.summary).length;
    return result(`落下 conversation=0 project=${entries.length} scope=${scope || "(空)"} summary=${withSummary}`, effects);
  }
  if (name === "memory_update") {
    const memoryId = String(args.memoryId ?? "").trim();
    const text = String(args.text ?? "").trim();
    if (!/^(?:mm|lm)_[0-9]{2,}$/.test(memoryId)) {
      return failedTool(errorDetail("memory_id_pattern"), "invalid_arguments", { toolName: name });
    }
    if (!text) return failedTool(errorDetail("memory_text_empty"), "invalid_arguments", { toolName: name });
    if (!input.conversationId) return failedTool(errorDetail("memory_update_missing_session"), "invalid_arguments");
    return result(JSON.stringify({
      ok: true,
      memoryId,
      layer: memoryId.startsWith("lm_") ? "project" : "conversation",
      text,
    }), [{ type: "memory_update", memoryId, text }]);
  }
  if (name === "memory_delete") {
    const memoryId = String(args.memoryId ?? "").trim();
    if (!/^(?:mm|lm)_[0-9]{2,}$/.test(memoryId)) {
      return failedTool(errorDetail("memory_id_pattern"), "invalid_arguments", { toolName: name });
    }
    return result(JSON.stringify({
      ok: true,
      memoryId,
      layer: memoryId.startsWith("lm_") ? "project" : "conversation",
    }), [{ type: "memory_delete", memoryId }]);
  }
  if (name === "context_query" || name === "agent_query") {
    const ids = [args.sumId, args.loopId, args.taskId].filter(value => value !== undefined);
    if (ids.length !== 1 || typeof ids[0] !== "string" || !ids[0].trim()) {
      return failedTool("必须提供且仅提供一个非空 sumId、loopId 或 taskId", "invalid_arguments");
    }
    if (args.taskId !== undefined) {
      if (!input.conversationId) return failedTool("任务查询需要当前会话", "invalid_arguments");
      const task = loadLedger(dataDir, input.conversationId).tasks.find(item => item.id === args.taskId);
      return result(JSON.stringify(task
        ? { ok: true, status: "complete", taskId: task.id, task }
        : { ok: false, status: "not_found", faultCode: "not_found", taskId: args.taskId }));
    }
    if (!input.queryContext) return failedTool(errorDetail("query_agent_unavailable"), "query_failed");
    const file = typeof args.file === "string" && args.file.trim() ? args.file.trim() : undefined;
    const queried = await input.queryContext({
      ...(typeof args.sumId === "string" ? { sumId: args.sumId } : { loopId: args.loopId as string }),
      module: args.module as QueryModule, intent: String(args.intent), ...(file ? { file } : {}),
    });
    return result(JSON.stringify({ ...queried, ...(file ? { file } : {}) }));
  }
  if (name === "agent_compress") {
    if (!input.compressContext) return failedTool(errorDetail("compression_agent_unavailable"), "compression_failed");
    const outcome = await input.compressContext();
    return result(JSON.stringify({ ok: outcome.status === "completed" || outcome.status === "noop", ...outcome }));
  }
  if ((JOB_TOOL_NAMES as readonly string[]).includes(name)) {
    if (!input.conversationId) return failedTool(errorDetail("job_missing_session"), "invalid_arguments");
    return externalResult(await runJobTool(name, hostArgs(args), jobScope(dataDir, input.conversationId)));
  }
  if ((STREAM_TOOL_NAMES as readonly string[]).includes(name)) {
    return externalResult(await runStreamTool(name, hostArgs(args), host, dataDir, input.conversationId));
  }
  if ((IMAGE_TOOL_NAMES as readonly string[]).includes(name)) {
    return externalResult(await runImageTool(name, hostArgs(args), host, dataDir, input.conversationId));
  }
  if (name === "asset_list") {
    if (!input.conversationId) return failedTool(errorDetail("asset_list_missing_session"), "invalid_arguments");
    const assets = loadAssets(dataDir, input.conversationId).filter((item) => {
      if (typeof args.kind === "string" && args.kind && item.kind !== args.kind) return false;
      if (typeof args.name === "string" && args.name.trim() && !item.name.includes(args.name.trim())) return false;
      return true;
    });
    return result(JSON.stringify({ ok: true, assets }));
  }
  if (name === "asset_read") {
    if (!input.conversationId) return failedTool(errorDetail("asset_read_missing_session"), "invalid_arguments");
    const assetId = String(args.assetId ?? "").trim();
    const asset = loadAssets(dataDir, input.conversationId).find((item) => item.assetId === assetId);
    if (!asset) return failedTool(errorDetail("asset_not_found", { assetId }), "file_not_found");
    if (asset.kind === "image") {
      const imageId = asset.name.replace(/\.[^.]+$/, "");
      const rect = { x: args.x, y: args.y, width: args.width, height: args.height };
      if (Object.values(rect).every((n) => typeof n === "number")) {
        return externalResult(await runImageTool("image_crop", { imageId, ...rect }, host, dataDir, input.conversationId));
      }
      return result(JSON.stringify({ ok: true, asset, fetchHint: "要像素请传 x/y/width/height 走 image_crop，或 capture_page(mode=element|rect)" }));
    }
    if (args.startLine !== undefined) return failedTool("asset_read 使用 blockId 或 keyword 读取文本", "invalid_arguments");
    if (args.blockId !== undefined && (typeof args.blockId !== "string" || !args.blockId.trim())) return failedTool("blockId 必须是非空字符串", "invalid_arguments");
    if (args.keyword !== undefined && (typeof args.keyword !== "string" || !args.keyword.trim())) return failedTool("keyword 必须是非空字符串", "invalid_arguments");
    if (args.blockId !== undefined && args.keyword !== undefined) return failedTool("blockId 与 keyword 不能同时提供", "invalid_arguments");
    if (args.offset !== undefined && (args.keyword === undefined || typeof args.offset !== "number" || !Number.isSafeInteger(args.offset) || args.offset < 0)) return failedTool("offset 仅用于搜索且必须是非负整数", "invalid_arguments");
    if (!asset.source.callId) {
      const path = join(dataDir, "conversations", input.conversationId, asset.path);
      const indexPath = `${path}.index.json`;
      const index: BlockIndex = existsSync(indexPath)
        ? JSON.parse(readFileSync(indexPath, "utf8")) as BlockIndex
        : buildBlockIndex(readFileSync(path, "utf8"), { path: asset.path, maxChars: retrievalWindowChars() });
      if (!existsSync(indexPath)) writeFileSync(indexPath, JSON.stringify(index));
      return result(JSON.stringify({ asset, ...retrieveEvidenceBlock(index, args, `asset:${assetId}`, path) }), [], true);
    }
    return await executeTool({
      ...input,
      name: "evidence_search",
      arguments: {
        reason: typeof args.reason === "string" ? args.reason : "asset_read",
        windows: [{
          callId: asset.source.callId,
          ...(args.keyword !== undefined ? { keyword: args.keyword } : {}),
          ...(args.blockId !== undefined ? { blockId: args.blockId } : {}),
          ...(args.offset !== undefined ? { offset: args.offset } : {}),
        }],
      },
    });
  }

  if ((LOCAL_TOOL_NAMES as readonly string[]).includes(name)) {
    if (!input.conversationId) return failedTool(errorDetail("local_missing_session"), "invalid_arguments");
    let evidenceIndex: BlockIndex | undefined;
    const value = await runLocalTool(name, hostArgs(args), dataDir, input.conversationId, (index) => { evidenceIndex = index; });
    const execution = externalResult(value);
    return evidenceIndex ? { ...execution, evidenceIndex, admitted: true } : execution;
  }
  if ((SERVICE_TOOL_NAMES as readonly string[]).includes(name)) {
    return externalResult(await runServiceTool(dataDir, name, hostArgs(args), input.signal, input.conversationId));
  }
  if ((COMPOUND_TOOL_NAMES as readonly string[]).includes(name)) {
    if (!host) return failedTool(errorDetail("browser_bridge_missing", { name }), "browser_unavailable");
    const compoundArgs = hostArgs(input.arguments);
    if ((compoundArgs.tabId === undefined || compoundArgs.tabId === null) && Number.isInteger(input.defaultTabId) && input.defaultTabId! >= 0) {
      compoundArgs.tabId = input.defaultTabId;
    }
    return externalResult(await runCompoundTool(name, compoundArgs, host));
  }
  if (browserNames.includes(name)) {
    if (!host) return failedTool(errorDetail("browser_bridge_missing", { name }), "browser_unavailable");
    const args = hostArgs(input.arguments);
    if ((args.tabId === undefined || args.tabId === null) && Number.isInteger(input.defaultTabId) && input.defaultTabId! >= 0) {
      args.tabId = input.defaultTabId;
    }
    return externalResult(await host.execute(name, args));
  }
  return failedTool(errorDetail("tool_unwired", { name }), "unknown_tool");
}
