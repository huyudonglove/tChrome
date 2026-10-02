import { errorMessage } from "../../shared/errors.ts";
import { errorDetail } from "../../shared/error-details.ts";
import type { QueryModule, QueryResult } from "../agents/query/types.ts";
import type { QueryRecord, QueryEvidence } from "../context/projections/queries.ts";
import type { ToolEffect, ToolExecution } from "./effects.ts";
import type { BrowserHost, CurrentPage, ToolArguments } from "../types.ts";
import { SERVICE_TOOL_NAMES, runServiceTool } from "./service-tools.ts";
import { STREAM_TOOL_NAMES, runStreamTool } from "./stream-tools.ts";
import { IMAGE_TOOL_NAMES, runImageTool } from "./image-crop.ts";
import { loadAssets, textFlavor } from "../assets/catalog.ts";
import { admitReturn, retrievalWindowChars } from "../admission.ts";
import { LOCAL_TOOL_NAMES, runLocalTool } from "./local-tools.ts";
import { COMPOUND_TOOL_NAMES, runCompoundTool } from "./compound-tools.ts";
import { JOB_TOOL_NAMES, runJobTool, withJobHeartbeat, jobScope } from "./job-registry.ts";
import { loadSkillManifest, skillCatalog, skillCatalogPage } from "../skills/loader.ts";
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
  browserNames: string[];
  host?: BrowserHost;
  signal?: AbortSignal;
  queryContext?: (args: {sumId: string; module: QueryModule; intent: string}) => Promise<QueryResult>;
  compressContext?: (args: { phase: "history" | "current" }) => Promise<{
    status: "completed" | "stopped" | "noop";
    committedTurnIds: string[];
    failedTurnId?: string;
    totalTurns: number;
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
  if (name === "reportProgress") {
    const text = String(args.text ?? "").trim();
    if (!text) return failedTool(errorDetail("report_progress_empty"), "invalid_arguments");
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
  if (name === "reflect.write") {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text) return failedTool(errorDetail("reflect_empty_text"), "invalid_arguments", { toolName: name });
    if (!input.conversationId) return failedTool(errorDetail("reflect_missing_session"), "invalid_arguments", { toolName: name });
    const focus = typeof args.focus === "string" && args.focus.trim() ? args.focus.trim() : undefined;
    const replaceId = typeof args.id === "string" && args.id.trim() ? args.id.trim() : undefined;
    const id = replaceId ?? allocateRecordId(dataDir, input.conversationId, "reflect");
    return result(JSON.stringify({ ok: true, id, text, ...(focus ? { focus } : {}) }),
      [{ type: "reflect.write", id, text, ...(focus ? { focus } : {}), ...(replaceId ? { replace: true } : {}) }]);
  }
  if (name === "reflect.delete") {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!/^rf_[0-9]{2,}$/.test(id)) return failedTool(errorDetail("reflect_bad_id"), "invalid_arguments", { toolName: name });
    return result(JSON.stringify({ ok: true, id, deleted: true }), [{ type: "reflect.delete", id }]);
  }
  if (name === "notes.write") {
    const key = String(args.key ?? "").trim();
    const value = String(args.value ?? "");
    return key ? result(`notes[${key}]=${value}`, [{ type: "note.write", key, value }]) : failedTool(errorDetail("notes_key_empty"), "invalid_arguments");
  }
  if (name === "notes.delete") {
    const key = String(args.key ?? "").trim();
    return key ? result(`deleted notes[${key}]`, [{ type: "note.delete", key }]) : failedTool(errorDetail("notes_key_empty"), "invalid_arguments");
  }
  if (name === "observation.write") {
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
      [{ type: "observation.write", observationType, result: args.result, ...(tabId !== undefined ? { tabId } : {}), ...(validForTurns !== undefined ? { validForTurns } : {}), ...(refresh !== undefined ? { refresh } : {}) }]);
  }
  if (name === "tabs.current") {
    if (!host?.readCurrentTabs) return failedTool(errorDetail("browser_not_connected"), "browser_unavailable");
    const tabs = await host.readCurrentTabs();
    return result(JSON.stringify(tabs));
  }
  if (name === "page.clear_result") {
    const pageId = String(args.pageId ?? "").trim();
    if (!pageId) return failedTool("pageId 空着", "invalid_arguments");
    if (input.observationIds && !input.observationIds.includes(pageId)) {
      return failedTool(errorDetail("page_clear_missing_obs", { pageId }), "invalid_arguments");
    }
    return result(JSON.stringify({ ok: true, pageId, cleared: true }),
      [{ type: "page.clear_result", pageId }]);
  }
  if (name === "task.set") {
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
      [{ type: "task.set", ...(title ? { title } : {}), items }]);
  }
  if (name === "task.update") {
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
    const hasBlocked = updates.some((row) => Boolean(row.blockedReason));
    return result(JSON.stringify({
      ok: true,
      updated: updates.length,
      ...(taskId ? { taskId } : {}),
      ...(hasBlocked ? { hint: "runtime: 任务步骤已记录 blockedReason。若确认原方案不可行或认知发生转折，建议调用 reflect.write 沉淀判断变化或放弃理由。" } : {}),
    }), [{ type: "task.update", ...(taskId ? { taskId } : {}), items: updates }]);
  }
  if (name === "task.complete") {
    const taskId = typeof args.taskId === "string" && args.taskId.trim() ? args.taskId.trim() : undefined;
    const reason = typeof args.reason === "string" && args.reason.trim() ? args.reason.trim() : undefined;
    return result(JSON.stringify({ ok: true, ...(taskId ? { taskId } : {}) }),
      [{ type: "task.complete", ...(taskId ? { taskId } : {}), ...(reason ? { reason } : {}) }]);
  }
  if (name === "tab.context") {
    const action = String(args.action ?? "get");
    if (action === "set") {
      const tabId = Number(args.tabId);
      if (!Number.isInteger(tabId) || tabId < 0) return failedTool(errorDetail("tab_context_set_tab"), "invalid_arguments");
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
    if (!input.conversationId) return failedTool(errorDetail("evidence_missing_session"), "invalid_arguments");
    const windows = Array.isArray(args.windows) ? args.windows as Record<string, unknown>[] : [];
    if (windows.length < 1 || windows.length > 8) return failedTool(errorDetail("evidence_windows_range"), "invalid_arguments");
    // charBudget：本窗口可用字符预算（单次调用总额按剩余窗口数摊分下来）。
    // 传 null 表示不摊分——levelId 是一次性按块取回正文，不与其他窗口分摊。
    const searchOne = (win: Record<string, unknown>, charBudget: number | null): Record<string, unknown> => {
      const keyword = typeof win.keyword === "string" ? win.keyword : "";
      const callId = typeof win.callId === "string" ? win.callId.trim() : "";
      const pageId = typeof win.pageId === "string" ? win.pageId.trim() : "";
      if (!callId && !pageId) return { ok: false, faultCode: "invalid_arguments", detail: errorDetail("evidence_source_exclusive") };
      if (callId && pageId) return { ok: false, faultCode: "invalid_arguments", detail: errorDetail("evidence_source_both") };
      // levelId: 分层索引树按块寻址（L1.2 / L2.1…），只回该 chunk 正文，不走原文行窗。
      const levelId = typeof win.levelId === "string" ? win.levelId.trim() : "";
      if (levelId) {
        if (!callId) return { ok: false, faultCode: "invalid_arguments", detail: errorDetail("evidence_level_needs_call") };
        const dir = paths(dataDir, input.conversationId!).returns;
        const manifestPath = join(dir, `${callId}.index.json`);
        if (!existsSync(manifestPath)) {
          return { ok: false, faultCode: "not_found", source: `call:${callId}`, path: manifestPath, mode: "level", levelId, detail: errorDetail("evidence_level_missing_tree") };
        }
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          levels?: { id: string; name: string; chunks: { id: string; from: number; to: number; chars: number; path: string }[] }[];
        };
        const level = (manifest.levels ?? []).find((l) => l.chunks.some((c) => c.id === levelId));
        const chunk = level?.chunks.find((c) => c.id === levelId);
        if (!level || !chunk) {
          return { ok: false, faultCode: "not_found", source: `call:${callId}`, path: manifestPath, mode: "level", levelId, detail: errorDetail("evidence_level_unknown") };
        }
        const chunkPath = join(dir, chunk.path);
        const content = readFileSync(chunkPath, "utf8");
        return {
          ok: true, source: `call:${callId}`, path: chunkPath, mode: "level",
          levelId, levelName: level.name, from: chunk.from, to: chunk.to,
          chars: content.length, content,
        };
      }
      const rawStart = win.startLine;
      const startLine = rawStart == null || rawStart === "" ? null : Number(rawStart);
      const hasLineMode = startLine !== null;
      const hasKeyword = Boolean(keyword.trim());
      // keyword alone → search; startLine alone → lines; both → hybrid (region-anchored search).
      if (!hasLineMode && !hasKeyword) return { ok: false, faultCode: "invalid_arguments", detail: errorDetail("evidence_need_mode") };
      if (startLine !== null && (!Number.isInteger(startLine) || startLine < 1)) return { ok: false, faultCode: "invalid_arguments", detail: errorDetail("evidence_start_line_int") };
      const rawPad = win.paddingLines;
      const paddingLines = rawPad == null || rawPad === "" ? 0 : Number(rawPad);
      if (!Number.isInteger(paddingLines) || paddingLines < 0 || paddingLines > 50) {
        return { ok: false, faultCode: "invalid_arguments", detail: errorDetail("evidence_padding_range") };
      }
      const limits = runtimeConfig.results;
      const rawWindow = Number(win.contextChars ?? limits.searchContextChars);
      // 窗口预算 = 摊分额度与入窗门禁取小（摊分额度已由 retrievalWindowChars 起算，这里只做双保险）
      const charCap = charBudget == null ? retrievalWindowChars() : charBudget;
      const contextChars = Number.isFinite(rawWindow)
        ? Math.min(charCap, Math.max(20, Math.floor(rawWindow)))
        : Math.min(limits.searchContextChars, charCap);
      // contextChars 是「本次取回总额」而非单侧上限：先按命中数摊分，再摊到 before/after 两侧，
      // 这样无论命中几条、每侧多长，单次取回都不会超过入窗门禁。
      const sideChars = (hitCount: number, hitLen: number): number =>
        Math.max(20, Math.floor((contextChars / Math.max(1, hitCount) - hitLen) / 2));
      const lineWidth = limits.lineWidth;
      let haystack = "";
      let source = "";
      let path = "";
      if (callId) {
        path = join(paths(dataDir, input.conversationId!).returns, `${callId}.txt`);
        haystack = loadFullReturn(dataDir, input.conversationId!, callId) ?? "";
        source = `call:${callId}`;
      } else {
        const textPath = join(dataDir, "conversations", input.conversationId!, "context-records", "observation", `${pageId}.txt`);
        const jsonPath = join(dataDir, "conversations", input.conversationId!, "context-records", "observation", `${pageId}.json`);
        path = textPath;
        if (existsSync(textPath)) {
          haystack = readFileSync(textPath, "utf8");
        } else {
          path = jsonPath;
          const raw = loadContextRecord(dataDir, input.conversationId!, "observation", pageId);
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
          detail: errorDetail("evidence_file_missing"),
        };
      }

      /** Slice lines mode window starting at actualFrom (after padding), contextChars budget. */
      const sliceLinesWindow = (targetLine: number, pad: number) => {
        const actualFrom = Math.max(1, targetLine - pad);
        if (targetLine > totalLines) return null;
        let used = 0;
        let to = actualFrom - 1;
        while (to < totalLines) {
          const next = lines[to]!.length;
          if (to >= actualFrom && used + next > contextChars) break;
          used += next;
          to += 1;
          if (used >= contextChars) break;
        }
        if (to < actualFrom) to = actualFrom;
        const slice = lines.slice(actualFrom - 1, to).map((text, index) => ({
          line: actualFrom + index,
          text,
          isTarget: (actualFrom + index) === targetLine,
        }));
        return { actualFrom, to, slice };
      };

      const keywordMatchesIn = (region: string, regionBaseLine: number) => {
        const matches: { offset: number; lineStart: number; lineEnd: number; before: string; hit: string; after: string }[] = [];
        const lower = region.toLowerCase();
        const needle = keyword.toLowerCase();
        let from = 0;
        while (matches.length < limits.searchMaxMatches) {
          const at = lower.indexOf(needle, from);
          if (at === -1) break;
          const side = sideChars(matches.length + 1, keyword.length);
          const before = region.slice(Math.max(0, at - side), at);
          const hit = region.slice(at, at + keyword.length);
          const after = region.slice(at + keyword.length, at + keyword.length + side);
          const prefix = region.slice(0, at);
          const lineInRegion = regionBaseLine + (prefix.match(/\n/g)?.length ?? 0);
          matches.push({ offset: at, lineStart: lineInRegion, lineEnd: lineInRegion, before, hit, after });
          from = at + Math.max(1, keyword.length);
        }
        // If plain indexOf missed because wrap inserted newlines inside the keyword.
        if (!matches.length && !region.includes("\n")) return matches;
        if (!matches.length) {
          const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const pattern = escaped.split("").join("[\\r\\n]?");
          try {
            const re = new RegExp(pattern, "gi");
            let m: RegExpExecArray | null;
            while ((m = re.exec(region)) !== null && matches.length < limits.searchMaxMatches) {
              const at = m.index;
              const hitRaw = m[0];
              const side = sideChars(matches.length + 1, hitRaw.length);
              const before = region.slice(Math.max(0, at - side), at);
              const after = region.slice(at + hitRaw.length, at + hitRaw.length + side);
              const prefix = region.slice(0, at);
              const lineInRegion = regionBaseLine + (prefix.match(/\n/g)?.length ?? 0);
              matches.push({ offset: at, lineStart: lineInRegion, lineEnd: lineInRegion, before, hit: hitRaw, after });
              re.lastIndex = at + Math.max(1, keyword.length);
            }
          } catch {
            // ignore pathological patterns
          }
        }
        return matches;
      };

      if (hasLineMode && hasKeyword) {
        // Hybrid: keyword search anchored to startLine window.
        const window = sliceLinesWindow(startLine!, paddingLines);
        if (!window) {
          return {
            ok: false, faultCode: "not_found", source, path, mode: "hybrid",
            lineWidth, totalLines, totalChars, startLine, detail: `startLine 超出总行数 ${totalLines}`,
          };
        }
        const region = window.slice.map((row) => row.text).join("\n");
        const matches = keywordMatchesIn(region, window.actualFrom);
        return {
          ok: matches.length > 0,
          source, path, mode: "hybrid",
          keyword, startLine, targetLine: startLine, paddingLines,
          anchorFrom: window.actualFrom, anchorTo: window.to,
          contextChars, lineWidth, totalLines, totalChars,
          matchCount: matches.length,
          matches,
          ...(matches.length ? {} : { faultCode: "not_found", detail: errorDetail("evidence_hybrid_miss") }),
        };
      }

      if (hasLineMode) {
        const window = sliceLinesWindow(startLine!, paddingLines);
        if (!window) {
          return {
            ok: false, faultCode: "not_found", source, path, mode: "lines",
            lineWidth, totalLines, totalChars, startLine, detail: `startLine 超出总行数 ${totalLines}`,
          };
        }
        return {
          ok: true, source, path, mode: "lines",
          lineWidth, totalLines, totalChars,
          startLine: window.actualFrom,
          targetLine: startLine,
          paddingLines,
          endLine: window.to,
          contextChars,
          lines: window.slice,
        };
      }

      // keyword-only search
      const matches: { offset: number; lineStart: number; lineEnd: number; before: string; hit: string; after: string }[] = [];
      const lowerHay = haystack.toLowerCase();
      const needle = keyword.toLowerCase();
      let from = 0;
      while (matches.length < limits.searchMaxMatches) {
        const at = lowerHay.indexOf(needle, from);
        if (at === -1) break;
        const side = sideChars(matches.length + 1, keyword.length);
        const before = haystack.slice(Math.max(0, at - side), at);
        const hit = haystack.slice(at, at + keyword.length);
        const after = haystack.slice(at + keyword.length, at + keyword.length + side);
        const lineStart = lineNumberAt(haystack, at);
        const lineEnd = lineNumberAt(haystack, at + hit.length - 1);
        matches.push({ offset: at, lineStart, lineEnd, before, hit, after });
        from = at + Math.max(1, keyword.length);
      }
      // Cross-wrap fallback: wrapCachedText inserts \\n inside what was one continuous keyword.
      if (!matches.length && keyword.length > 1) {
        const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = escaped.split("").join("[\\r\\n]?");
        try {
          const re = new RegExp(pattern, "gi");
          let m: RegExpExecArray | null;
          while ((m = re.exec(haystack)) !== null && matches.length < limits.searchMaxMatches) {
            const at = m.index;
            const hitRaw = m[0];
            const side = sideChars(matches.length + 1, hitRaw.length);
            const before = haystack.slice(Math.max(0, at - side), at);
            const after = haystack.slice(at + hitRaw.length, at + hitRaw.length + side);
            const lineStart = lineNumberAt(haystack, at);
            const lineEnd = lineNumberAt(haystack, at + hitRaw.length - 1);
            matches.push({ offset: at, lineStart, lineEnd, before, hit: hitRaw, after });
            re.lastIndex = at + Math.max(1, keyword.length);
          }
        } catch {
          // ignore
        }
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
        ...(matches.length ? {} : { faultCode: "not_found", detail: errorDetail("evidence_keyword_miss") }),
      };
    };
    // 单次调用总额摊分：预算是「一次调用」的总字符数，不是每窗口各拿一份。
    // 每行除命中正文外还有固定结构开销（source/path/mode/JSON 包装），按 ROW_OVERHEAD 预留，
    // 否则实际产出仍会顶破入窗门禁。收窄后取不完的窗口不再硬塞，显式标记 truncated/droppedWindows，
    // 让模型知道这是主动裁剪而不是丢了窗口。
    const budget = retrievalWindowChars();
    // 每窗口除命中正文外还有固定结构开销（source/path/mode/JSON 包装），按指针壳预留留位。
    const ROW_OVERHEAD = runtimeConfig.results.pointerShellReserve;
    const serialize = (rows: Record<string, unknown>[], dropped: number[]): string =>
      // 主动裁剪不是执行失败：dropped 只描述「因预算没取完」，用 truncated/droppedWindows 表达；
      // 若并进 ok，Runtime 会按 ok=false 补一个 tool_execution_failed，把预算裁剪误报成工具报错。
      JSON.stringify({
        ok: rows.every((row) => row.ok),
        results: rows,
        ...(dropped.length ? { truncated: true, droppedWindows: dropped } : {}),
      });
    const results: Record<string, unknown>[] = [];
    const droppedWindows: number[] = [];
    for (let i = 0; i < windows.length; i += 1) {
      const win = windows[i]!;
      const levelId = typeof win.levelId === "string" ? win.levelId.trim() : "";
      const pending = windows.length - i;
      if (levelId) {
        // 按块取回不参与摊分：它已按 id 精确定位到小块正文，不可再窄，也不该被丢弃。
        results.push(searchOne(win, null));
        continue;
      }
      const used = serialize(results, droppedWindows).length + ROW_OVERHEAD * pending;
      if (used >= budget) {
        droppedWindows.push(i);
        continue;
      }
      results.push(searchOne(win, Math.max(20, Math.floor((budget - used) / pending))));
    }
    // 摊分后总量已被 retrievalWindowChars 钉住，属「已按门禁预算裁剪」的取回型返回：
    // 再过一次 admitReturn 只可能把它降级成目录，形成「取回→外置→再取回」死循环。
    return result(serialize(results, droppedWindows), [], true);
  }
  if (name === "skill.list") {
    const keyword = typeof args.keyword === "string" && args.keyword.trim() ? args.keyword.trim() : undefined;
    const numArg = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;
    const page = skillCatalogPage(repoRoot, { keyword, offset: numArg(args.offset), limit: numArg(args.limit) });
    return result(JSON.stringify({ ok: true, ...page }));
  }
  if (name === "skill.load") {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!id) return failedTool(errorDetail("skill_load_empty_id"), "invalid_arguments", { toolName: name });
    if (loadSkillManifest(repoRoot).residentSkillIds.includes(id)) {
      return failedTool(errorDetail("skill_resident", { id }), "invalid_arguments", { toolName: name });
    }
    const hit = skillCatalog(repoRoot).find(item => item.id === id);
    if (!hit) return failedTool(errorDetail("skill_unknown", { id }), "invalid_arguments", { toolName: name });
    return result(JSON.stringify({ ok: true, id: hit.id, summary: hit.summary, purpose: hit.purpose }), [{ type: "skill.load", id }]);
  }
  if (name === "catalog.add") {
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
  if (name === "memory.writeConversation") {
    const entries = asStringArray(args.conversationMemory).map((text) => ({
      layer: "conversation" as const, text,
    }));
    const effects: ToolEffect[] = entries.length ? [{ type: "memory.append", entries }] : [];
    return result(`落下 conversation=${entries.length} project=0`, effects);
  }
  if (name === "memory.writeProject") {
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
  if (name === "memory.update") {
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
    }), [{ type: "memory.update", memoryId, text }]);
  }
  if (name === "memory.delete") {
    const memoryId = String(args.memoryId ?? "").trim();
    if (!/^(?:mm|lm)_[0-9]{2,}$/.test(memoryId)) {
      return failedTool(errorDetail("memory_id_pattern"), "invalid_arguments", { toolName: name });
    }
    return result(JSON.stringify({
      ok: true,
      memoryId,
      layer: memoryId.startsWith("lm_") ? "project" : "conversation",
    }), [{ type: "memory.delete", memoryId }]);
  }
  if (name === "context.query" || name === "agent.query") {
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
  if (name === "agent.compress") {
    if (!input.compressContext) return failedTool("compression_agent_unavailable", "compress_failed");
    const phase = args.phase === "current" ? "current" : "history";
    const outcome = await input.compressContext({ phase });
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
  if (name === "asset.list") {
    if (!input.conversationId) return failedTool(errorDetail("asset_list_missing_session"), "invalid_arguments");
    const assets = loadAssets(dataDir, input.conversationId).filter((item) => {
      if (typeof args.kind === "string" && args.kind && item.kind !== args.kind) return false;
      if (typeof args.name === "string" && args.name.trim() && !item.name.includes(args.name.trim())) return false;
      return true;
    });
    return result(JSON.stringify({ ok: true, assets }));
  }
  if (name === "asset.read") {
    if (!input.conversationId) return failedTool(errorDetail("asset_read_missing_session"), "invalid_arguments");
    const assetId = String(args.assetId ?? "").trim();
    const asset = loadAssets(dataDir, input.conversationId).find((item) => item.assetId === assetId);
    if (!asset) return failedTool(errorDetail("asset_not_found", { assetId }), "file_not_found");
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
      // 取回窗口按 retrievalWindowChars 留位（与 evidence.search 同源），而不是按 inlineChars：
      // 外层还要 JSON.stringify 包 asset 元数据，按入窗门禁裁剪仍会被顶破。
      const fetchBudget = retrievalWindowChars();
      const window = args.startLine
        ? full.split(/\r?\n/).slice(Number(args.startLine) - 1, Number(args.startLine) + 3).join("\n")
        : typeof args.keyword === "string" && args.keyword
          ? full.slice(Math.max(0, full.indexOf(args.keyword) - Math.floor(fetchBudget / 2)), Math.max(0, full.indexOf(args.keyword) - Math.floor(fetchBudget / 2)) + fetchBudget)
          : full.slice(0, fetchBudget);
      const admitted = admitReturn(window, { path: asset.path, name: asset.name });
      // window 已由 admitReturn 按取回门禁裁过（或本就是短片段），不再二次外置。
      // 外层还要 JSON.stringify 包 asset 元数据，故片段本体按 retrievalWindowChars 留位，
      // 与 evidence.search 取回同源，避免「已裁剪的取回型返回」再被顶破外置。
      return admitted.mode === "inline"
        ? result(JSON.stringify({ ok: true, asset, window: admitted.text, flavor: textFlavor(window) }), [], true)
        : result(JSON.stringify({ ok: true, asset, ...((admitted as { payload?: Record<string, unknown> }).payload ?? {}), flavor: textFlavor(window) }), [], true);
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
    if (!input.conversationId) return failedTool(errorDetail("local_missing_session"), "invalid_arguments");
    return externalResult(await runLocalTool(name, hostArgs(args), dataDir, input.conversationId));
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
