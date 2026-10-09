import { saveContextRecord } from "./records.ts";
import { allocateRecordId, inputRecord } from "./ids.ts";
import { loadMemories } from "../memory/store.ts";
import { storeToolImages } from "../images/tool-result.ts";
import { admitExecution, admitImages, deferredImageNote } from "../admission.ts";
import { escalate } from "./escalation.ts";
import { appendRuntime, inputLoop, recordHelm, recordToolResult, setLoopNotice } from "./loop-records.ts";
import { hasActiveTask, requiresActiveTask } from "./task-gate.ts";
import { repeatHint } from "./repeat-detect.ts";
import { ensureThumb, loadThumbRef } from "../images/thumb.ts";
import { deriveActiveScopes, projectMemories, renderScopeIndex } from "../memory/window.ts";
import { errorInfo, errorMessage } from "../../shared/errors.ts";
import { errorDetail } from "../../shared/error-details.ts";
import { failedTool, toolFailure } from "../tools/result.ts";
import { systemText, userText, windowChars } from "../context/window.ts";
import { beginExecution, hasActiveExecution } from "./execution.ts";
import { skillGuide, loadedSkillText } from "../skills/loader.ts";
import { loadContextModules, type ContextModules } from "../context/modules.ts";
import { loadToolRegistry, coreToolIds, dynamicToolIds, toolSchemas, toolGuideFor, zeroCallToolNote, type ToolRegistry } from "../tools/registry.ts";
import { executeTool } from "../tools/execute.ts";
import { SUBAGENT_TOOL_CAPABILITIES } from "../agents/subagent/tool-capabilities.ts";

// Observation nudge: counted on evidence-producing tool calls (not model sends), so a turn
// that only reads/threads bookkeeping stays quiet while a long取证 turn gets asked to checkpoint.
// Gates tighten 30 -> 20 -> 10 within a turn and reset after every observation_write.
// Marker prefix appended to the last tool return; stripped on the next pass so a nudge never sticks.
const OBSERVATION_NUDGE_MARKER = "runtime: 本回合已累计";

const REFLECT_NUDGE_MARKER = "runtime: 本回合尚未落反思";

const OBSERVATION_NUDGE_FIRST_GATE = runtimeConfig.context.observationNudgeFirstGate;
const OBSERVATION_NUDGE_MIN_GATE = runtimeConfig.context.observationNudgeMinGate;
const OBSERVATION_NUDGE_STEP = runtimeConfig.context.observationNudgeStep;
// Management / bookkeeping tools: their returns add no new evidence worth checkpointing.
const OBSERVATION_NUDGE_EXCLUDED = new Set([
  "observation_write",
  "reflect_write",
  "reflect_delete",
  "memory_writeConversation",
  "memory_writeProject",
  "memory_update",
  "memory_delete",
  "task_set",
  "task_update",
  "task_complete",
  "evidence_search",
  "page_clear_result",
  "image_crop",
  "catalog_add",
  "skill_load",
  "skill_list",
  "tab_context",
  "agent_compress",
  "agent_query",
  "context_query",
  "checkContinue",
  "askUser",
  "finishTurn",
]);
import type { ToolExecution } from "../tools/effects.ts";
import { applyToolEffects, archiveTurnReflection } from "./effects.ts";
import type {
  Assembled,
  BrowserHost,
  ChatMessage,
  CompletionResult,
  Ledger,
  Provider,
  ToolIOItem,
  Turn,
  TurnStopReason,
  TurnReply,
  ToolQueueItem,
  RuntimeExecutionContext,
} from "../types.ts";
import { checkToolCalls } from "../tools/schema.ts";
import { contextState, compressContext } from "./context-state.ts";
import { queryContext } from "../agents/query/index.ts";
import { nowIso, localDate } from "./ids.ts";
import { join } from "node:path";
import { runtimeConfig } from "../config/runtime.ts";
import {
  ensureSession,
  loadLedger,
  loadTurn,
  paths,
  recoverStaleRun,
  saveFullReturn,
  saveReturnBlockIndex,
  saveLedger,
  saveTurn,
  appendEvent,
} from "./store.ts";
import { executionContext, pauseActiveTask } from "./tasks.ts";

// stopTurn already persists cancellation. A superseded worker must never write
// its stale ledger back over a newer turn (or recreate a deleted conversation).
const stoppedReply = (ledger: Ledger, turn: Turn): TurnReply => ({
  conversationId: ledger.conversationId,
  turnId: turn.turnId,
  stopReason: { kind: "interrupted", initiatedBy: "user" },
});

/**
 * interrupt 走的是 applyToolEffects 之前的提前返回，turn.reply 的收尾
 * （回合落 completed、账本翻 idle）会被整个跳过——不补做的话账本永远停在 running，
 * 回复也无法投影进会话视图（回合已写 stop-reason 事件但状态永不翻转）。
 * liveTools 这里一并清空：提前返回时同波工具可能仍在执行，wave 的清空逻辑不会再跑到。
 */
const closeForcedReply = (ledger: Ledger, turn: Turn, text: string): void => {
  turn.status = "completed";
  turn.completedAt = nowIso();
  turn.stopReason = { kind: "reply", text };
  ledger.status = "idle";
  ledger.active = null;
  ledger.pendingAsk = null;
  ledger.toolQueue = [];
  ledger.liveTools = [];
  archiveTurnReflection(ledger, turn);
};

const wasStopped = (dataDir: string, conversationId: string, turnId: string, expectedStatus: Ledger["status"] = "running") => {
  const current = loadLedger(dataDir, conversationId);
  if (current.status !== expectedStatus) return true;
  // Tool effects persist completion before returning to the coordinator. Its own
  // idle state is valid only while this remains the latest completed turn.
  return expectedStatus === "idle"
    ? current.active !== null || current.turnIds.at(-1) !== turnId
    : current.active?.turnId !== turnId;
};

const MAX_SUBMIT = 3;

export type LoopDeps = {
  dataDir: string;
  repoRoot: string;
  provider: Provider;
  host?: BrowserHost;
  signal?: AbortSignal;
};

const assemble = (toolRegistry: ToolRegistry, loadedToolIds: string[]): Assembled => ({
  baseToolsIds: [...toolRegistry.toolGroups.baseToolsIds],
  toolIds: [...new Set([...coreToolIds(toolRegistry), ...loadedToolIds])],

  conversationMemoryIds: [],
  projectMemoryIds: [],
  mcpIds: [],
  currentPage: null,
  observations: [],
  currentTabs: { ok: false, error: "尚未读取标签列表" },
});
const messagesOf = (contextModules: ContextModules, toolRegistry: ToolRegistry, ledger: Ledger, turn: Turn, memories: ReturnType<typeof loadMemories>, skillText: string, images: ChatMessage["images"], summaries: Parameters<typeof userText>[0]["conversationSummaries"] = [], dataDir?: string, skillNav = "", historyDataDir?: string, onNotice?: (kind: string, text: string | null) => void, allCalls: readonly { name: string; arguments?: unknown }[] = ledger.toolIO): ChatMessage[] => {
  const system = systemText(contextModules, localDate(), toolGuideFor(toolRegistry, turn.assembled.baseToolsIds), {
    cwd: process.cwd(),
    ...(dataDir ? { dataDir } : {}),
  }, skillNav);
  const { inline, deferred } = admitImages(images ?? []);
  const thumbs: NonNullable<ChatMessage["images"]> = [];
  if (dataDir) {
    for (const image of deferred) {
      const thumb = loadThumbRef(dataDir, ledger.conversationId, image.id);
      if (thumb) thumbs.push({ ...thumb, ...("callId" in image ? { callId: (image as { callId?: string }).callId } : {}) });
    }
  }
  // Ownership: the project a turn touches decides which scoped memories are injected. Derivation is
  // evidence-based (paths in the recent tool calls), never a declared guess.
  const activeScopes = deriveActiveScopes(allCalls);
  // 图片附件、未注入的记忆范围、零调用的已加载工具这三条附注，与其他运行时提醒同一承载：
  // 交给当前未发送 loop 的 runtime notice，每条独立编号。
  // 只在本次请求准备阶段按 kind 更新；已发送的历史不改写。
  onNotice?.("image", deferredImageNote(deferred) + (thumbs.length ? " 已附缩略图，细节仍需 image_crop 或 mode=element|rect。" : ""));
  onNotice?.("memory", renderScopeIndex(memories, activeScopes));
  onNotice?.("tools", zeroCallToolNote(toolRegistry, ledger.loadedToolIds, allCalls));
  return [
    { role: "system", content: system },
    { role: "user", content: userText({
      contextModules, ledger, turn, memories: projectMemories(memories, activeScopes), skillText, conversationSummaries: summaries,
      queryHistory: ledger.queryHistory,
      toolGuide: toolGuideFor(toolRegistry, turn.assembled.toolIds, false),
      dataDir: historyDataDir ?? dataDir,
      ...(dataDir ? { inlineBudget: { dataDir, system } } : {}),
    }), images: [...inline, ...thumbs] },
  ];
};

// Manual compress reports what it bought: re-assemble the post-compression view and measure it.
// Best-effort by design — a measurement failure must never break the tool call.
const windowMeasurer = (
  dataDir: string,
  repoRoot: string,
  contextModules: ContextModules,
  toolRegistry: ToolRegistry,
  ledger: Ledger,
  turn: Turn,
  memories: ReturnType<typeof loadMemories>,
  images: ChatMessage["images"],
  skillNav: string,
): (() => number | null) => () => {
  try {
    const state = contextState(dataDir, ledger, turn, memories);
    const view = messagesOf(
      contextModules,
      toolRegistry,
      state.ledger,
      state.turn,
      state.memories,
      loadedSkillText(repoRoot, ledger.loadedSkillIds ?? []),
      images,
      state.summaries,
      dataDir,
      skillNav,
    );
    return windowChars(view[0]!.content, view[1]!.content);
  } catch {
    return null;
  }
};

// Every provider result crosses the same policy boundary before execution.
// Providers parse transport data; only runtime decides which tools may run.
const validateCompletion = (
  raw: CompletionResult,
  tools: Parameters<typeof checkToolCalls>[1],
  baseToolsIds: string[],
  toolIds: string[],
  mutexGroups: Parameters<typeof checkToolCalls>[4],
) => {
  const batch = checkToolCalls(raw.toolCalls, tools, baseToolsIds, toolIds, mutexGroups);
  const checks = raw.toolCalls.map((call) => ({
    call,
    check: checkToolCalls([call], tools, baseToolsIds, toolIds, mutexGroups),
  }));
  const result: CompletionResult = raw.finish === "error" ? raw : {
    ...raw,
    ...batch,
    parseOk: raw.parseOk,
    ...(!raw.parseOk ? { faultCode: raw.faultCode, badName: raw.badName, detail: raw.detail, missing: raw.missing } : {}),
  };
  return { result, batch, checks,
    validCalls: ["exclusive_resident", "script_steps_separate"].includes(batch.faultCode ?? "") ? [] : checks.filter(({ check }) => check.schemaOk).map(({ call }) => call),
  };
};

const writeFault = (dataDir: string, ledger: Ledger, turnId: string, result: CompletionResult, tools: Parameters<typeof checkToolCalls>[1]) => {
  const name = result.badName || result.toolCalls.at(-1)?.name || "unknown";
  const call = result.toolCalls.find((row) => row.name === name) ?? result.toolCalls.at(-1);
  const isFormatFault = result.faultCode === "arguments_not_json";
  // A wrong_type fault already names the offending field and the shape it accepts inside detail
  // (e.g. "data/contextChars must be <= 200"), so reattaching the whole parameter schema only
  // buries the one actionable line under hundreds of characters of noise.
  const suppressesSchema = isFormatFault || result.faultCode === "wrong_type";
  // Format faults: do not persist broken payload; return a correct usage example instead of the raw error.
  const detail = isFormatFault
    ? errorDetail(/}\s*\{/.test(result.detail ?? "") ? "arguments_json_concat" : "arguments_json_invalid")
    : (result.detail ?? "");
  const text = JSON.stringify(toolFailure({
    ok: false,
    faultCode: result.faultCode,
    missing: result.missing,
    toolName: name,
    detail,
    details: suppressesSchema
      ? {}
      : { parameterSchema: tools.find(tool => tool.function.name === name)?.function.parameters },
  }));
  ledger.toolIO.push({
    callId: call?.id ?? allocateRecordId(dataDir, ledger.conversationId, "call"),
    name,
    turnId,
    arguments: isFormatFault ? {} : (call?.arguments ?? {}),
    return: { stage: "complete", totalChars: text.length, text },
  });
};

// Schedule is a Runtime-owned property of each tool. The model may read it to
// order calls, but cannot override it through arguments.
const resolveExecutionMode = (
  item: { name: string },
  defaults: Record<string, "parallel" | "serial">,
): "parallel" | "serial" => defaults[item.name] ?? "serial";

const runQueue = async (input: {
  dataDir: string;
  ledger: Ledger;
  turn: Turn;
  toolRegistry: ToolRegistry;
  browserNames: string[];
  host?: BrowserHost;
  provider: Provider;
  repoRoot: string;
  signal?: AbortSignal;
  measureWindow?: () => number | null;
}): Promise<TurnStopReason | null> => {
  const { dataDir, ledger, turn, toolRegistry, host, browserNames } = input;
  // Microtask/macrotask schedule over the batch: parallel joins the current wave;
  // serial drains the wave first, then runs alone with no overlap.
  type Slot = { item: ToolQueueItem; index: number; mode: "parallel" | "serial"; execCtx: RuntimeExecutionContext };
  const batch = ledger.toolQueue.splice(0, ledger.toolQueue.length);
  const slots: Slot[] = batch.map((item, index) => ({
    item,
    index,
    mode: resolveExecutionMode(item, toolRegistry.execution),
    execCtx: executionContext(ledger),
  }));
  const done = new Map<number, ToolExecution>();
  /** 只读判定唯一来源：capability metadata 的 readOnly 标记。 */
  const readOnlyTools = new Set(toolRegistry.capabilities.filter((c) => c.readOnly).map((c) => c.id));
  /** Effective risk per call: the model's own value, otherwise the tool's fixed level. */
  const riskAudit = new Map<string, { risk: string; riskSource: "model" | "fixed" }>();
  const inflight = new Set<Promise<void>>();
  const live = new Map<number, { name: string; callId: string; reason?: string }>();
  let appliedUpTo = -1;
  let closed: TurnStopReason | null = null;

  const syncQueue = (nextStart: number) => {
    if (wasStopped(dataDir, ledger.conversationId, turn.turnId)) return;
    ledger.toolQueue = slots.slice(nextStart).map((slot) => slot.item);
    ledger.liveTools = [...live.values()];
    saveLedger(dataDir, ledger);
  };

  const launch = (slot: Slot, nextStart: number): Promise<void> => {
    const reason = typeof slot.item.arguments?.reason === "string" ? slot.item.arguments.reason : undefined;
    live.set(slot.index, { name: slot.item.name, callId: slot.item.callId, ...(reason ? { reason } : {}) });
    turn.usage ??= { modelRequests: 0, toolCalls: 0 };
    turn.usage.toolCalls += 1;
    syncQueue(nextStart);
    if (!wasStopped(dataDir, ledger.conversationId, turn.turnId)) saveTurn(dataDir, turn);
    const running = (async () => {
      let execution: ToolExecution;
      try {
        const toolRisk = toolRegistry.capabilities.find((row) => row.kind === "tool" && row.id === slot.item.name)?.risk;
        // Model arguments stay untouched; the effective level is only recorded so every call is auditable.
        const modelRisk = slot.item.arguments.risk;
        if (typeof modelRisk === "string") {
          riskAudit.set(slot.item.callId, { risk: modelRisk, riskSource: "model" });
        } else if (toolRisk && toolRisk !== "unknown") {
          riskAudit.set(slot.item.callId, { risk: toolRisk, riskSource: "fixed" });
        }
        if (requiresActiveTask(toolRisk, slot.item.arguments.risk) && !hasActiveTask(ledger)) {
          execution = failedTool(errorDetail("task_gate_required"), "task_gate_required", {
            toolName: slot.item.name,
          });
        } else {
          execution = await executeTool({
            name: slot.item.name,
            arguments: slot.item.arguments,
            dataDir,
            conversationId: ledger.conversationId,
            browserNames,
            host,
            // delegate_subagent 需要 provider 才能跑子代理；此前漏传，导致该工具一调就回
            // provider_unavailable（execute.ts 的判空）。provider 由 runQueue 入参传入。
            provider: input.provider,
            signal: input.signal,
            // Subagent 的候选 schema 用完整声明集（本轮基础工具 + 全部动态工具 + 核心工具），
            // 而不是只取本轮主模型恰好加载的那一份——否则主会话没加载某个工具时，子代理会静默
            // 失去这项能力。真正暴露给某个子代理的工具，仍由 packet.permissions 与
            // SUBAGENT_TOOL_CAPABILITIES 两重收窄。
            subagentTools: toolSchemas(toolRegistry, [...new Set([
              ...turn.assembled.baseToolsIds,
              ...turn.assembled.toolIds,
              // 用 registry 导出的过滤版本：coreToolIds() 会剔除没有 schema 的声明项。
              // toolSchemas 对缺失项直接抛错，而这个调用在每次工具调度的公共路径上，
              // 一旦抛错会把本轮所有工具调用一起打成 tool_execution_failed。
              ...coreToolIds(toolRegistry),
              ...dynamicToolIds(toolRegistry),
            ])]),
            subagentToolCapabilities: SUBAGENT_TOOL_CAPABILITIES,
            observationIds: turn.assembled.observations.map((row) => row.id),
            defaultTabId: ledger.contextTab?.tabId ?? null,
            queryContext: args => queryContext({ dataDir, conversationId: ledger.conversationId, repoRoot: input.repoRoot, provider: input.provider, ...args, isCancelled: () => wasStopped(dataDir, ledger.conversationId, turn.turnId) }),
            // Manual compress answers a question the outcome alone cannot: did it actually shrink the window?
            compressContext: async () => {
              const before = input.measureWindow?.() ?? null;
              let started = false;
              try {
                const outcome = await compressContext({ dataDir, repoRoot: input.repoRoot, provider: input.provider, ledger, turn,
                  memories: loadMemories(dataDir, ledger.conversationId, ledger.memoryIds),
                  isCancelled: () => wasStopped(dataDir, ledger.conversationId, turn.turnId),
                  onStart: () => { started = true; appendEvent(dataDir, ledger.conversationId, { kind: "compress-start", turnId: turn.turnId, data: { source: "agent" } }); },
                  onProgress: (progress) => appendEvent(dataDir, ledger.conversationId, { kind: "compress-progress", turnId: turn.turnId, data: { source: "agent", ...progress } }),
                });
                // GUI 指示由 kind:"compress"/"compress-error" 清除；agent 路径此前只发 start/progress，
                // 压缩结束后指示一直停留，必须补完成事件（noop 时从未 start，无须发）。
                if (started) appendEvent(dataDir, ledger.conversationId, { kind: "compress", turnId: turn.turnId, data: { source: "agent", beforeChars: before, afterChars: input.measureWindow?.() ?? null } });
                return { ...outcome, windowChars: { before, after: input.measureWindow?.() ?? null } };
              } catch (error) {
                if (started) appendEvent(dataDir, ledger.conversationId, { kind: "compress-error", turnId: turn.turnId, data: { source: "agent" } });
                throw error;
              }
            },
            lookup: {
              knownTools: Object.keys(toolRegistry.tools),
              enabledTools: [...turn.assembled.toolIds, ...toolRegistry.toolGroups.baseToolsIds],
              unusedTools: dynamicToolIds(toolRegistry).filter((id) => !turn.assembled.toolIds.includes(id) && !toolRegistry.toolGroups.baseToolsIds.includes(id)),
              protectedTools: toolRegistry.toolGroups.baseToolsIds,
            },
          });
        }
      } catch (error) {
        // A failed tool is evidence for the model to correct its next call. It must
        // pass through the same recording/effect boundary as any normal result.
        execution = failedTool(error, "tool_execution_failed", { toolName: slot.item.name });
      }
      done.set(slot.index, execution);
      live.delete(slot.index);
    })();
    const tracked = running.then(() => { inflight.delete(tracked); }, () => { inflight.delete(tracked); });
    inflight.add(tracked);
    return tracked;
  };

  const applyReady = async (): Promise<TurnStopReason | null> => {
    while (appliedUpTo + 1 < slots.length && done.has(appliedUpTo + 1)) {
      if (wasStopped(dataDir, ledger.conversationId, turn.turnId)) {
        return { kind: "interrupted", initiatedBy: "user" };
      }
      const index = appliedUpTo + 1;
      const slot = slots[index]!;
      const execution = done.get(index)!;
      appliedUpTo = index;
      const item = slot.item;
      const observed = (([...turn.assembled.observations].reverse().find((row) => row.callId === item.callId)?.result ?? {}) as { url?: string; title?: string });
      const stored = storeToolImages(dataDir, ledger.conversationId, execution.text, {
        tool: item.name, callId: item.callId,
        ...(typeof item.arguments.tabId === "number" ? { tabId: item.arguments.tabId } : {}),
        ...(typeof item.arguments.ref === "string" ? { element: item.arguments.ref } : {}),
        ...(observed.url ? { url: observed.url } : {}),
        ...(observed.title ? { tabTitle: observed.title } : {}),
      });
      for (const image of stored.images) {
        if (image.bytes > runtimeConfig.results.imageInlineBytes) {
          await ensureThumb(dataDir, ledger.conversationId, image, host);
        }
      }
      const full = stored.text;
      saveFullReturn(dataDir, ledger.conversationId, item.callId, full);
      if (execution.evidenceIndex) saveReturnBlockIndex(dataDir, ledger.conversationId, item.callId, execution.evidenceIndex);
      // 原文与统一块索引使用同一来源调用；取回型结果直接内联，避免再次外置。
      const admittedText = admitExecution(
        full,
        execution.admitted,
        {
          callId: item.callId,
          name: item.name,
          path: join(paths(dataDir, ledger.conversationId).returns, `${item.callId}.txt`),
        },
        {
          persistIndex: (index) =>
            saveReturnBlockIndex(dataDir, ledger.conversationId, item.callId, index),
        },
      );
      const viewText = admittedText.mode === "inline" ? admittedText.text : JSON.stringify(admittedText.payload);
      const row: ToolIOItem = {
        ...item,
        turnId: turn.turnId,
        ...(stored.images.length ? { images: stored.images } : {}),
        ...(stored.imagesError ? { imagesError: stored.imagesError } : {}),
        return: { stage: "complete", totalChars: full.length, text: viewText },
        ...(riskAudit.get(item.callId) ?? {}),
        ...(slot.execCtx.activeTaskId ? { taskId: slot.execCtx.activeTaskId } : {}),
        ...(slot.execCtx.activeTaskItemId ? { taskItemId: slot.execCtx.activeTaskItemId } : {}),
      };
      ledger.toolIO.push(row);
      const turnRows = ledger.toolIO.filter((r) => r.turnId === turn.turnId);
      // Hint only: identical calls or identical repeated failures are flagged, never blocked.
      const repeated = repeatHint(turnRows, ledger.toolIO);
      if (repeated) {
        row.runtimeHints = [repeated];
      }
      const escalation = escalate(turnRows, item.name, readOnlyTools);
      if (escalation.action === "interrupt") {
        recordToolResult(dataDir, ledger, row);
        appendRuntime(dataDir, ledger, turn.turnId, "notice", { kind: "budget", scope: "loop", text: escalation.text });
        closeForcedReply(ledger, turn, escalation.text);
        saveTurn(dataDir, turn);
        saveLedger(dataDir, ledger);
        return { kind: "reply", text: escalation.text };
      }
      setLoopNotice(dataDir, ledger, turn.turnId, "budget", escalation.action === "hint" ? escalation.text : null);
      let output: TurnStopReason | null = null;
      try {
        output = applyToolEffects({
          dataDir, ledger, turn, call: item, effects: execution.effects,
          execCtx: slot.execCtx, storedText: full,
        });
      } catch (error) {
        if (wasStopped(dataDir, ledger.conversationId, turn.turnId)) return { kind: "interrupted", initiatedBy: "user" };
        // Effects can fail after earlier writes succeeded. Report evidence without replaying them.
        const text = failedTool(error, "tool_execution_failed", { toolName: item.name,
          details: { executionState: "部分操作可能已生效，请先检查已保存记录与当前状态，不要直接重放整批操作。" } }).text;
        row.return = { stage: "complete", totalChars: text.length, text };
        saveFullReturn(dataDir, ledger.conversationId, item.callId, text);
        saveTurn(dataDir, turn);
        saveLedger(dataDir, ledger);
      }
      recordToolResult(dataDir, ledger, row);
      saveTurn(dataDir, turn);
      // Tool calls are not written to events.jsonl: toolio.jsonl is the single source of truth
      // (it carries turnId/batchId/risk/taskId and is amended in place to the final return), and
      // projectSessionView falls back to ledger.toolIO when a turn has no tool events.
      if (output) return output;
    }
    return null;
  };

  const drainWave = async (): Promise<TurnStopReason | null> => {
    while (inflight.size) {
      await Promise.race(inflight);
      if (wasStopped(dataDir, ledger.conversationId, turn.turnId)) {
        return { kind: "interrupted", initiatedBy: "user" };
      }
      const out = await applyReady();
      if (out) return out;
    }
    return applyReady();
  };

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    if (wasStopped(dataDir, ledger.conversationId, turn.turnId)) {
      return { kind: "interrupted", initiatedBy: "user" };
    }
    if (slot.mode === "parallel") {
      void launch(slot, i + 1);
      closed = await applyReady();
      if (closed) break;
    } else {
      closed = await drainWave();
      if (closed) break;
      if (wasStopped(dataDir, ledger.conversationId, turn.turnId)) {
        return { kind: "interrupted", initiatedBy: "user" };
      }
      await launch(slot, i + 1);
      if (wasStopped(dataDir, ledger.conversationId, turn.turnId)) {
        return { kind: "interrupted", initiatedBy: "user" };
      }
      closed = await applyReady();
      if (closed) break;
    }
  }
  if (!closed) closed = await drainWave();
  if (!wasStopped(dataDir, ledger.conversationId, turn.turnId)) {
    ledger.liveTools = [...live.values()];
    saveLedger(dataDir, ledger);
  }
  return closed;
};

export async function handleTurn(
  deps: LoopDeps,
  body: {
    userInput: string;
    submittedAt: string;
    conversationId?: string;
  },
): Promise<TurnReply> {
  // Route by the caller's conversation; the global pointer is only a fallback.
  const session = { conversationId: body.conversationId || ensureSession(deps.dataDir).conversationId };
  const host = deps.host?.forScope?.(session.conversationId) ?? deps.host;
  let ledger = loadLedger(deps.dataDir, session.conversationId);
  if (ledger.status === "running") {
    // 账本说 running，但本进程已经没有任何该会话的执行在跑 → 上一进程被硬杀留下的脏数据。
    // 直接复位它，否则这条会话会被 busy 永久拒绝（只有重启服务或手动 /stop 才能解开）。
    if (hasActiveExecution(deps.dataDir, ledger.conversationId)) {
      return {
        conversationId: ledger.conversationId,
        turnId: ledger.active?.turnId ?? "",
        stopReason: { kind: "error", faultCode: "busy" },
      };
    }
    recoverStaleRun(deps.dataDir, ledger.conversationId, "账本残留 running，但该会话已无在跑的执行");
    ledger = loadLedger(deps.dataDir, ledger.conversationId);
  }
  const prevId = ledger.turnIds.at(-1);
  if (prevId) {
    const last = loadTurn(deps.dataDir, ledger.conversationId, prevId);
    ledger.userInputHistory.push(inputRecord(last));
  }
  const contextModules = loadContextModules(deps.repoRoot);
  const skillNav = skillGuide(deps.repoRoot);
  const skillTextOf = () => loadedSkillText(deps.repoRoot, ledger.loadedSkillIds ?? []);
  let skillText = skillTextOf();
  const toolRegistry = loadToolRegistry(deps.repoRoot);
  const turnId = allocateRecordId(deps.dataDir, ledger.conversationId, "turn");
  const turn: Turn = {
    turnId,
    conversationId: ledger.conversationId,
    status: "assembling",
    createdAt: nowIso(),
    completedAt: null,
    input: { id: allocateRecordId(deps.dataDir, ledger.conversationId, "input"), text: body.userInput, submittedAt: body.submittedAt },
    assembled: assemble(toolRegistry, ledger.loadedToolIds),
    actions: [],
    stopReason: null,
    usage: { modelRequests: 0, toolCalls: 0 },
  };
  saveContextRecord(deps.dataDir, ledger.conversationId, "userInput", inputRecord(turn));
  turn.assembled.conversationMemoryIds = [...ledger.memoryIds.conversation];
  turn.assembled.projectMemoryIds = loadMemories(deps.dataDir, ledger.conversationId, ledger.memoryIds).project.map(item => item.memoryId);
  appendRuntime(deps.dataDir, ledger, turnId, "userInput", { text: body.userInput, submittedAt: body.submittedAt });
  ledger.turnIds.push(turnId);
  ledger.status = "running";
  ledger.active = { turnId };
  ledger.pendingAsk = null;
  ledger.toolQueue = [];
  turn.status = "inferring";
  saveTurn(deps.dataDir, turn);
  saveLedger(deps.dataDir, ledger);
  appendEvent(deps.dataDir, ledger.conversationId, {
    kind: "normalize",
    turnId,
    data: { userInput: body.userInput, submittedAt: body.submittedAt, userInputHistory: ledger.userInputHistory },
  });
  appendEvent(deps.dataDir, ledger.conversationId, {
    kind: "assemble",
    turnId,
    data: { assembled: turn.assembled },
  });
  const execution = beginExecution(deps.dataDir, ledger.conversationId, turn.turnId, deps.provider);
  deps = { ...deps, provider: execution.provider, signal: execution.signal };
  try {
    let submitFails = 0;
    let evidenceCallsSinceObservation = 0;
    // Evidence calls already covered by an earlier nudge in this turn, so the gate measures the
    // calls made *since* the last nudge instead of re-firing on the same cumulative total.
    let nudgedEvidenceCount = 0;
    let observationWrites = 0;
    let observationNudgeGate = OBSERVATION_NUDGE_FIRST_GATE;
    // Reflect rides the same tightening chain as the observation nudge: it starts at the same gate
    // and is reset by the same observation_write, so the two never stack on the same 20-call window.
    let reflectNudgeGate = OBSERVATION_NUDGE_FIRST_GATE;
    let imageBatchId: string | undefined;
    const setNotice = (kind: string, text: string | null) => setLoopNotice(deps.dataDir, ledger, turnId, kind, text);
    while (true) {
      if (wasStopped(deps.dataDir, ledger.conversationId, turn.turnId)) {
          return stoppedReply(ledger, turn);
        }
      const currentLoop = inputLoop(deps.dataDir, ledger, turnId);
      saveTurn(deps.dataDir, turn);
      const memories = loadMemories(deps.dataDir, ledger.conversationId, ledger.memoryIds);
      turn.assembled.projectMemoryIds = memories.project.map(item => item.memoryId);
      // Tool results already contain persisted image paths. Select attachments before
      // measuring/compressing text; only the preceding model response's batch is visual.
      const images: ChatMessage["images"] = imageBatchId === undefined ? [] : ledger.toolIO
        .filter(item => item.turnId === turn.turnId && item.batchId === imageBatchId)
        .flatMap(item => (item.images ?? []).map(image => ({ ...image, callId: item.callId })));
      // Nudge on evidence-producing tool calls: count this turn's toolIO, skipping bookkeeping tools.
      const rows = ledger.toolIO.filter((r) => r.turnId === turn.turnId);
      // 临时提醒每次发送前重算；budget 保留 runQueue 按最新工具返回计算的状态。
      for (const kind of ["observation", "reflect", "compress", "rotate"]) {
        setNotice(kind, null);
      }
      const writeCount = rows.filter((r) => r.name === "observation_write").length;
      if (writeCount > observationWrites) {
        observationWrites = writeCount;
        observationNudgeGate = OBSERVATION_NUDGE_FIRST_GATE;
        reflectNudgeGate = OBSERVATION_NUDGE_FIRST_GATE;
        nudgedEvidenceCount = 0;
      }
      // Count only the evidence calls made since the most recent observation_write, so a real
      // checkpoint resets both the counter and the gate instead of just the gate.
      const lastWriteAt = rows.reduce((acc, r, i) => (r.name === "observation_write" ? i : acc), -1);
      const evidenceRows = rows.slice(lastWriteAt + 1).filter((r) => !OBSERVATION_NUDGE_EXCLUDED.has(r.name));
      evidenceCallsSinceObservation = evidenceRows.length;
      if (evidenceCallsSinceObservation - nudgedEvidenceCount >= observationNudgeGate) {
        nudgedEvidenceCount = evidenceCallsSinceObservation;
        observationNudgeGate = Math.max(OBSERVATION_NUDGE_MIN_GATE, observationNudgeGate - OBSERVATION_NUDGE_STEP);
        reflectNudgeGate = Math.max(OBSERVATION_NUDGE_MIN_GATE, reflectNudgeGate - OBSERVATION_NUDGE_STEP);
        const tally = new Map<string, number>();
        for (const row of evidenceRows) tally.set(row.name, (tally.get(row.name) ?? 0) + 1);
        const detail = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name}×${n}`).join("、");
        setNotice("observation",
          `${OBSERVATION_NUDGE_MARKER} ${evidenceCallsSinceObservation} 次产出证据的工具调用（${detail}），尚未写阶段观察。已有工具结果可直接复用；压缩会保留摘要，原文仍可回查。若跨步骤状态尚未记录，可用 observation_write 补充当前进度、未验证项与衔接点，不重复搬运工具返回；已有信息足够时继续执行。下次提示门槛收紧到 ${observationNudgeGate} 次。`);
      }
      // Reflect nudge: counted on raw calls for the turn rather than evidence calls, because
      // reflection tracks judgement changes and repeated dead ends, which pure reading also triggers.
      const reflectWritten = rows.some((row) => row.name === "reflect_write");
      if (rows.length >= reflectNudgeGate && !reflectWritten) {
        setNotice("reflect",
          `${REFLECT_NUDGE_MARKER}\n本回合已有 ${rows.length} 次工具调用，尚未写 reflect_write。若这轮出现了结论被推翻、同一卡点反复、或一次取舍决策，用 reflect_write 记下当前状态与下一步；纯流水账不必写。`);
      }
      let state = contextState(deps.dataDir, ledger, turn, memories);
      let messages = messagesOf(contextModules, toolRegistry, state.ledger, state.turn, state.memories, skillText, images, state.summaries, undefined, skillNav, deps.dataDir, setNotice, ledger.toolIO);
      const initialChars = windowChars(messages[0]!.content, messages[1]!.content);
      if (initialChars >= ledger.compressAt) {
        let compressionStarted = false;
        try {
          await compressContext({ ...deps, ledger, turn, memories,
            isCancelled: () => wasStopped(deps.dataDir, ledger.conversationId, turnId),
            onStart: () => {
              compressionStarted = true;
              appendEvent(deps.dataDir, ledger.conversationId, { kind: "compress-start", turnId, data: {} });
            },
            onProgress: progress => appendEvent(deps.dataDir, ledger.conversationId, { kind: "compress-progress", turnId, data: { ...progress } }),
          });
          if (wasStopped(deps.dataDir, ledger.conversationId, turnId)) return stoppedReply(ledger, turn);
          state = contextState(deps.dataDir, ledger, turn, memories);
          messages = messagesOf(contextModules, toolRegistry, state.ledger, state.turn, state.memories, skillText, images, state.summaries, undefined, skillNav, deps.dataDir, setNotice, ledger.toolIO);
          if (compressionStarted) appendEvent(deps.dataDir, ledger.conversationId, { kind: "compress", turnId, data: { beforeChars: initialChars, afterChars: windowChars(messages[0]!.content, messages[1]!.content) } });
        } catch (error) {
          if (wasStopped(deps.dataDir, ledger.conversationId, turnId)) return stoppedReply(ledger, turn);
          if (compressionStarted) appendEvent(deps.dataDir, ledger.conversationId, { kind: "compress-error", turnId, data: errorInfo(error, "compression_failed") });
          throw error;
        }
      }
      // The send boundary compresses first, then fails the turn when the settled view is
      // still over the hard inline limit.
      try {
        skillText = skillTextOf();
        messages = messagesOf(contextModules, toolRegistry, state.ledger, state.turn, state.memories, skillText, images, state.summaries, deps.dataDir, skillNav, undefined, setNotice, ledger.toolIO);
      } catch (error) {
        turn.status = "failed";
        turn.completedAt = nowIso();
        turn.stopReason = { kind: "error", faultCode: "context_limit",
          detail: error instanceof Error ? error.message : String(error) };
        ledger.status = "failed";
        ledger.active = null;
        saveTurn(deps.dataDir, turn);
        saveLedger(deps.dataDir, ledger);
        appendEvent(deps.dataDir, ledger.conversationId, { kind: "context-budget-error", turnId, data: { detail: String(error) } });
        return { conversationId: ledger.conversationId, turnId, stopReason: turn.stopReason };
      }
      ledger.windowChars = windowChars(messages[0]!.content, messages[1]!.content);
      saveLedger(deps.dataDir, ledger);
      const tools = toolSchemas(toolRegistry, [...turn.assembled.baseToolsIds, ...turn.assembled.toolIds]);
      turn.usage!.modelRequests += 1;
      // boundSeq：本 Conversation 内第几次模型请求（b01…），新会话从 0 起。
      ledger.boundSeq = ledger.boundSeq + 1;
      saveTurn(deps.dataDir, turn);
      appendEvent(deps.dataDir, ledger.conversationId, {
        kind: "provider-request",
        turnId,
        data: { windowChars: ledger.windowChars, toolIds: [...turn.assembled.baseToolsIds, ...turn.assembled.toolIds], usage: { ...turn.usage } },
      });
      currentLoop.turnId = turnId;
      currentLoop.sentAt = nowIso();
      saveLedger(deps.dataDir, ledger);
      const providerResult = await deps.provider.complete({
        loopId: currentLoop.id,
        messages,
        tools,
        imageContext: { dataDir: deps.dataDir, conversationId: ledger.conversationId },
        ...(submitFails > 0 ? { toolChoice: "required" as const } : {}),
      });
      if (wasStopped(deps.dataDir, ledger.conversationId, turn.turnId)) {
          return stoppedReply(ledger, turn);
        }
      const providerCallIds: Record<string, string> = {};
      const byProviderId = new Map<string, string>();
      const localCallId = (providerId: string) => {
        let id = byProviderId.get(providerId);
        if (!id) {
          id = allocateRecordId(deps.dataDir, ledger.conversationId, "call");
          byProviderId.set(providerId, id);
          providerCallIds[id] = providerId;
        }
        return id;
      };
      const rawResult = { ...providerResult,
        toolCalls: providerResult.toolCalls.map(call => ({ ...call, id: localCallId(call.id) })),
        ...(providerResult.toolCallFaults ? { toolCallFaults: providerResult.toolCallFaults.map(fault => ({ ...fault, callId: localCallId(fault.callId) })) } : {}),
      };
      recordHelm(deps.dataDir, ledger, currentLoop, rawResult);
      saveLedger(deps.dataDir, ledger);
      const batchId = allocateRecordId(deps.dataDir, ledger.conversationId, "batch");
      const batchStart = ledger.toolIO.length;
      // Every response's records, including rejected calls and provider evidence,
      // share the next-request window. A new batch replaces one-shot visibility.
      const publishBatch = () => {
        const rows = ledger.toolIO.slice(batchStart);
        const observations = new Map(turn.assembled.observations
          .filter(item => item.turnId === turnId).map(item => [item.callId, item.id]));
        for (const row of rows) { row.batchId = batchId; recordToolResult(deps.dataDir, ledger, row); }
        ledger.lastAction = {
          batchId, turnId,
          calls: rows.map(row => ({ callId: row.callId, name: row.name,
            ...(observations.has(row.callId) ? { observationId: observations.get(row.callId)! } : {}),
          })),
        };
      };
      imageBatchId = batchId;
      const { result, batch: batchCheck, checks, validCalls } = validateCompletion(
        rawResult, tools, turn.assembled.baseToolsIds, turn.assembled.toolIds, toolRegistry.mutex,
      );
      appendEvent(deps.dataDir, ledger.conversationId, {
        kind: "provider-response",
        turnId,
        data: {
          finish: result.finish,
          content: result.content,
          toolCalls: result.toolCalls,
          ...(result.grounding ? { grounding: result.grounding } : {}),
          attempts: result.attempts,
          parseOk: result.parseOk,
          schemaOk: result.schemaOk,
          faultCode: result.faultCode,
          missing: result.missing,
          detail: result.detail ?? "",
        },
      });
      if (result.finish === "error") {
        turn.status = "failed";
        turn.completedAt = nowIso();
        turn.stopReason = { kind: "error", faultCode: result.faultCode ?? "provider_error",
          ...(result.detail ? { detail: result.detail } : {}) };
        ledger.status = "failed";
        ledger.active = null;
        ledger.liveTools = [];
        saveTurn(deps.dataDir, turn);
        saveLedger(deps.dataDir, ledger);
        appendEvent(deps.dataDir, ledger.conversationId, {
          kind: "turn-stop-reason",
          turnId,
          data: { output: turn.stopReason },
        });
        return { conversationId: ledger.conversationId, turnId, stopReason: turn.stopReason };
      }
      // Gemini google_search (and similar) already ran on the provider side. Record
      // evidence in toolIO without queueing it for Runtime execution or usage counts.
      if (result.grounding) {
        const groundingText = JSON.stringify({
          ok: true,
          provider: "gemini",
          queries: result.grounding.queries,
          sources: result.grounding.sources,
        });
        ledger.toolIO.push({
          callId: allocateRecordId(deps.dataDir, ledger.conversationId, "call"),
          turnId,
          ...(batchId ? { batchId } : {}),
          name: result.grounding.name,
          arguments: { reason: "runtime: 模型侧内置搜索已完成", queries: result.grounding.queries },
          return: { stage: "complete", totalChars: groundingText.length, text: groundingText },
        });
      }
      if (!result.parseOk || !result.schemaOk) {
        submitFails += 1;
        const batchBlocked = ["exclusive_resident", "script_steps_separate"].includes(batchCheck.faultCode ?? "");
        for (const fault of result.toolCallFaults ?? []) {
          writeFault(deps.dataDir, ledger, turnId, {
            ...result, badName: fault.name, faultCode: "arguments_not_json", detail: fault.detail, missing: [],
            toolCalls: [{ id: fault.callId, name: fault.name, arguments: {} }],
          }, tools);
        }
        if (!result.parseOk && !result.toolCallFaults?.length) writeFault(deps.dataDir, ledger, turnId, result, tools);
        if (batchBlocked) {
          writeFault(deps.dataDir, ledger, turnId, { ...result, ...batchCheck }, tools);
        } else {
          for (const { call, check } of checks) {
            if (!check.schemaOk) writeFault(deps.dataDir, ledger, turnId, { ...result, ...check, toolCalls: [call] }, tools);
          }
        }
        if (validCalls.length) {
          ledger.toolQueue = validCalls.map((call) => ({
            batchId,
            callId: call.id,
            name: call.name,
            arguments: call.arguments,
          }));
          const closed = await runQueue({
            dataDir: deps.dataDir,
            ledger,
            turn,
            toolRegistry,
            provider: deps.provider, repoRoot: deps.repoRoot, signal: deps.signal,
            browserNames: toolRegistry.index.browser,
            host,
            measureWindow: windowMeasurer(deps.dataDir, deps.repoRoot, contextModules, toolRegistry, ledger, turn, memories, images, skillNav),
          });
          if (wasStopped(deps.dataDir, ledger.conversationId, turn.turnId, ledger.status)) {
          return stoppedReply(ledger, turn);
        }
          publishBatch();
          saveTurn(deps.dataDir, turn);
          saveLedger(deps.dataDir, ledger);
          if (closed) {
            appendEvent(deps.dataDir, ledger.conversationId, {
              kind: "turn-stop-reason",
              turnId,
              data: { output: closed },
            });
            return { conversationId: ledger.conversationId, turnId, stopReason: closed };
          }
        }
        publishBatch();
        if (submitFails >= MAX_SUBMIT) {
          turn.status = "failed";
          turn.completedAt = nowIso();
          turn.stopReason = { kind: "error", faultCode: result.faultCode ?? "missing_required",
            toolName: result.badName, detail: result.detail };
          ledger.status = "failed";
          ledger.active = null;
          ledger.liveTools = [];
          saveTurn(deps.dataDir, turn);
          saveLedger(deps.dataDir, ledger);
          appendEvent(deps.dataDir, ledger.conversationId, {
            kind: "turn-stop-reason",
            turnId,
            data: { output: turn.stopReason },
          });
          return { conversationId: ledger.conversationId, turnId, stopReason: turn.stopReason };
        }
        saveTurn(deps.dataDir, turn);
        saveLedger(deps.dataDir, ledger);
        continue;
      }
      if (result.finish === "stop" && result.toolCalls.length === 0) {
        const textContent = (result.content ?? "").trim();
        if (textContent && !result.grounding) {
          const autoCallId = allocateRecordId(deps.dataDir, ledger.conversationId, "call");
          ledger.toolQueue = [{
            batchId,
            callId: autoCallId,
            name: "finishTurn",
            arguments: { text: textContent },
          }];
          const closed = await runQueue({
            dataDir: deps.dataDir,
            ledger,
            turn,
            toolRegistry,
            provider: deps.provider, repoRoot: deps.repoRoot, signal: deps.signal,
            browserNames: toolRegistry.index.browser,
            host,
            measureWindow: windowMeasurer(deps.dataDir, deps.repoRoot, contextModules, toolRegistry, ledger, turn, memories, images, skillNav),
          });
          publishBatch();
          saveTurn(deps.dataDir, turn);
          saveLedger(deps.dataDir, ledger);
          if (closed) {
            appendEvent(deps.dataDir, ledger.conversationId, {
              kind: "turn-stop-reason",
              turnId,
              data: { output: closed },
            });
            return { conversationId: ledger.conversationId, turnId, stopReason: closed };
          }
        }
        submitFails += 1;
        const failure = failedTool(errorMessage("need_finish_turn", "model"), "need_finish_turn");
        ledger.toolIO.push({
          callId: allocateRecordId(deps.dataDir, ledger.conversationId, "call"),
          name: "finishTurn",
          turnId,
          arguments: {},
          return: { stage: "complete", totalChars: failure.text.length, text: failure.text },
        });
        publishBatch();
        if (submitFails >= MAX_SUBMIT) {
          turn.status = "failed";
          turn.completedAt = nowIso();
          turn.stopReason = { kind: "error", faultCode: "need_finish_turn" };
          ledger.status = "failed";
          ledger.active = null;
          ledger.liveTools = [];
          saveTurn(deps.dataDir, turn);
          saveLedger(deps.dataDir, ledger);
          appendEvent(deps.dataDir, ledger.conversationId, {
            kind: "turn-stop-reason",
            turnId,
            data: { output: turn.stopReason },
          });
          return { conversationId: ledger.conversationId, turnId, stopReason: turn.stopReason };
        }
        saveTurn(deps.dataDir, turn);
        saveLedger(deps.dataDir, ledger);
        continue;
      }
      ledger.toolQueue = result.toolCalls.map((call) => ({
        batchId,
        callId: call.id,
        name: call.name,
        arguments: call.arguments,
      }));
      const closed = await runQueue({
        dataDir: deps.dataDir,
        ledger,
        turn,
        toolRegistry,
        provider: deps.provider, repoRoot: deps.repoRoot, signal: deps.signal,
        browserNames: toolRegistry.index.browser,
        host,
        measureWindow: windowMeasurer(deps.dataDir, deps.repoRoot, contextModules, toolRegistry, ledger, turn, memories, images, skillNav),
      });
      if (wasStopped(deps.dataDir, ledger.conversationId, turn.turnId, ledger.status)) {
          return stoppedReply(ledger, turn);
        }
      publishBatch();
      saveTurn(deps.dataDir, turn);
      // A plan whose items are all done is finished work; close it here so a
      // finished turn never leaves a zombie task behind. Persisted below.

      if (closed) pauseActiveTask(deps.dataDir, ledger, turnId);
      saveLedger(deps.dataDir, ledger);
      if (closed) {
        appendEvent(deps.dataDir, ledger.conversationId, {
          kind: "turn-stop-reason",
          turnId,
          data: { output: closed },
        });
        return { conversationId: ledger.conversationId, turnId, stopReason: closed };
      }
      // Successful tool batches are normal progress, not failed submissions.
      // Empty finishTurn calls must not create an unbounded retry loop.
      if (result.toolCalls.some((call) => call.name !== "finishTurn" && call.name !== "askUser")) {
        submitFails = 0;
      } else {
        submitFails += 1;
        if (submitFails >= MAX_SUBMIT) break;
      }
    }
    turn.status = "failed";
    turn.completedAt = nowIso();
    turn.stopReason = { kind: "error", faultCode: "empty_finish_turn" };
    ledger.status = "failed";
    ledger.active = null;
    ledger.liveTools = [];
    ledger.toolQueue = [];
    saveTurn(deps.dataDir, turn);
    saveLedger(deps.dataDir, ledger);
    appendEvent(deps.dataDir, ledger.conversationId, {
      kind: "turn-stop-reason",
      turnId,
      data: { output: turn.stopReason },
    });
    return { conversationId: ledger.conversationId, turnId, stopReason: turn.stopReason };
  } catch (error) {
    if (wasStopped(deps.dataDir, ledger.conversationId, turn.turnId)) {
          return stoppedReply(ledger, turn);
        }
    const failedLoop = ledger.loops.at(-1);
    if (failedLoop?.sentAt && !failedLoop.completedAt) failedLoop.completedAt = nowIso();
    const cause = errorInfo(error);
    appendRuntime(deps.dataDir, ledger, turnId, "notice", { kind: "error", scope: "loop", ...cause });
    const liveTool = ledger.liveTools[0];
    turn.status = "failed";
    turn.completedAt = nowIso();
    turn.stopReason = { kind: "error", faultCode: "tool_execution_failed", detail: cause.detail,
      ...(cause.faultCode !== "tool_execution_failed" ? { causeCode: cause.faultCode } : {}),
      ...(liveTool ? { toolName: liveTool.name } : {}) };
    ledger.status = "failed";
    ledger.active = null;
    ledger.liveTools = [];
    ledger.toolQueue = [];
    // Keep effects already applied before the exception; never replay the batch.
    if (liveTool) {
      const row = ledger.toolIO.find(item => item.callId === liveTool.callId);
      if (row) {
        const text = JSON.stringify(toolFailure({ ...cause, toolName: liveTool.name,
          details: { ...cause.details, executionState: "部分操作可能已生效，请先检查已保存记录与当前状态，不要直接重放整批操作。" } }));
        row.return = { stage: "complete", totalChars: text.length, text };
        saveFullReturn(deps.dataDir, ledger.conversationId, row.callId, text);
        recordToolResult(deps.dataDir, ledger, row);
      }
    }
    saveTurn(deps.dataDir, turn);
    saveLedger(deps.dataDir, ledger);
    appendEvent(deps.dataDir, ledger.conversationId, {
      kind: "turn-stop-reason", turnId,
      data: { output: turn.stopReason, ...(liveTool ? { callId: liveTool.callId } : {}),
        error: { ...cause, ...(error instanceof Error ? { stack: error.stack } : {}) } },
    });
    return { conversationId: ledger.conversationId, turnId, stopReason: turn.stopReason };
  } finally { execution.finish(); }
}

/** Host/UI submission boundary; model history is organized exclusively by loop. */
export async function runTurnWithContinuation(
  deps: LoopDeps,
  body: { userInput: string; submittedAt: string; conversationId?: string },
): Promise<TurnReply> {
  return handleTurn(deps, body);
}
