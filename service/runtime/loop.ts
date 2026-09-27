import { saveContextRecord } from "./records.ts";
import { allocateRecordId, inputRecord } from "./ids.ts";
import { loadMemories } from "../memory/store.ts";
import { storeToolImages } from "../images/tool-result.ts";
import { admitImages, admitReturn, deferredImageNote } from "../admission.ts";
import { escalate } from "./escalation.ts";
import { requiresActiveTask } from "./task-gate.ts";
import { repeatHint } from "./repeat-detect.ts";
import { ensureThumb, loadThumbRef } from "../images/thumb.ts";
import { projectMemories } from "../memory/window.ts";
import { errorInfo, errorMessage } from "../../shared/errors.ts";
import { errorDetail } from "../../shared/error-details.ts";
import { failedTool, toolFailure } from "../tools/result.ts";
import { systemText, userText, windowChars } from "../context/window.ts";
import { ContextBudgetError } from "../context/overflow.ts";
import { beginExecution } from "./execution.ts";
import { skillGuide, loadedSkillText } from "../skills/loader.ts";
import { loadContextModules, type ContextModules } from "../context/modules.ts";
import { loadToolRegistry, coreToolIds, dynamicToolIds, toolSchemas, toolGuideFor, type ToolRegistry } from "../tools/registry.ts";
import { executeTool } from "../tools/execute.ts";
import type { ToolExecution } from "../tools/effects.ts";
import { applyToolEffects } from "./effects.ts";
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
} from "../types.ts";
import { checkToolCalls } from "../tools/schema.ts";
import { contextState, compressContext } from "./context-state.ts";
import { queryContext } from "../agents/query/index.ts";
import { nowIso, pacificDate } from "./ids.ts";
import { join } from "node:path";
import { runtimeConfig } from "../config/runtime.ts";
import {
  ensureSession,
  loadLedger,
  loadTurn,
  paths,
  saveFullReturn,
  saveReturnIndexTree,
  saveLedger,
  saveTurn,
  appendEvent,
  appendProviderExchange,
} from "./store.ts";
import { executionContext } from "./tasks.ts";

// stopTurn already persists cancellation. A superseded worker must never write
// its stale ledger back over a newer turn (or recreate a deleted conversation).
const stoppedReply = (ledger: Ledger, turn: Turn): TurnReply => ({
  conversationId: ledger.conversationId,
  turnId: turn.turnId,
  stopReason: { kind: "interrupted", initiatedBy: "user" },
});

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

const messagesOf = (contextModules: ContextModules, toolRegistry: ToolRegistry, ledger: Ledger, turn: Turn, memories: ReturnType<typeof loadMemories>, skillText: string, images: ChatMessage["images"], summaries: Parameters<typeof userText>[0]["conversationSummaries"] = [], dataDir?: string, skillNav = "", historyDataDir?: string): ChatMessage[] => {
  const system = systemText(contextModules, pacificDate(), toolGuideFor(toolRegistry, turn.assembled.baseToolsIds), {
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
  const imageNote = deferredImageNote(deferred) + (thumbs.length ? " 已附缩略图，细节仍需 image.crop 或 mode=element|rect。" : "");
  return [
    { role: "system", content: system },
    { role: "user", content: userText({
      contextModules, ledger, turn, memories: projectMemories(memories), skillText, conversationSummaries: summaries,
      currentQuery: ledger.currentQuery, queryHistory: ledger.queryHistory,
      toolGuide: toolGuideFor(toolRegistry, turn.assembled.toolIds),
      dataDir: historyDataDir ?? dataDir,
      ...(dataDir ? { inlineBudget: { dataDir, system } } : {}),
    }) + (imageNote ? `\n\n${imageNote}` : ""), images: [...inline, ...thumbs] },
  ];
};

// Every provider result crosses the same policy boundary before execution.
// Providers parse transport data; only runtime decides which tools may run.
const validateCompletion = (
  raw: CompletionResult,
  tools: Parameters<typeof checkToolCalls>[1],
  baseToolsIds: string[],
  toolIds: string[],
) => {
  const batch = checkToolCalls(raw.toolCalls, tools, baseToolsIds, toolIds);
  const checks = raw.toolCalls.map((call) => ({
    call,
    check: checkToolCalls([call], tools, baseToolsIds, toolIds),
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
    details: isFormatFault
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
        if (slot.item.arguments.risk !== undefined) {
          riskAudit.set(slot.item.callId, { risk: slot.item.arguments.risk, riskSource: "model" });
        } else if (toolRisk && toolRisk !== "unknown") {
          riskAudit.set(slot.item.callId, { risk: toolRisk, riskSource: "fixed" });
        }
        if (requiresActiveTask(toolRisk, slot.item.arguments.risk) && !ledger.activeTaskId) {
          execution = failedTool(errorDetail("task_gate_required"), "invalid_arguments", {
            toolName: slot.item.name,
          });
        } else {
          execution = await executeTool({
            name: slot.item.name,
            arguments: slot.item.arguments,
            dataDir,
            conversationId: ledger.conversationId,
            browserNames,
            goalContext: { goals: ledger.goals, currentGoalId: ledger.currentGoalId, turnId: turn.turnId, sourceCallId: slot.item.callId },
            host,
            signal: input.signal,
            observationIds: turn.assembled.observations.map((row) => row.id),
            defaultTabId: ledger.contextTab?.tabId ?? null,
            queryContext: args => queryContext({ dataDir, conversationId: ledger.conversationId, repoRoot: input.repoRoot, provider: input.provider, ...args, isCancelled: () => wasStopped(dataDir, ledger.conversationId, turn.turnId) }),
            compressContext: ({ phase }) => compressContext({ dataDir, repoRoot: input.repoRoot, provider: input.provider, ledger, turn,
              memories: loadMemories(dataDir, ledger.conversationId, ledger.memoryIds),
              isCancelled: () => wasStopped(dataDir, ledger.conversationId, turn.turnId),
              onStart: () => appendEvent(dataDir, ledger.conversationId, { kind: "compress-start", turnId: turn.turnId, data: { source: "agent", phase } }),
              onProgress: (progress) => appendEvent(dataDir, ledger.conversationId, { kind: "compress-progress", turnId: turn.turnId, data: { source: "agent", ...progress } }),
            }, phase),
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
      // 分层索引树：L1/L2 每层都是完整一份，层内按门禁切 chunk、给可寻址 id，整树落盘供按 id 取回。
      // 落盘与指针渲染都交给 admitReturn：目录在这里只算一次，indexPath 也由同一处产生。
      const admittedText = admitReturn(
        full,
        {
          callId: item.callId,
          name: item.name,
          path: join(paths(dataDir, ledger.conversationId).returns, `${item.callId}.txt`),
        },
        {
          persistTree: (tree) =>
            saveReturnIndexTree(dataDir, ledger.conversationId, item.callId, tree),
        },
      );
      const viewText = admittedText.mode === "inline" ? admittedText.text : JSON.stringify(admittedText.payload);
      const row: ToolIOItem = {
        ...item,
        turnId: turn.turnId,
        ...(stored.images.length ? { images: stored.images } : {}),
        return: { stage: "complete", totalChars: full.length, text: viewText },
        ...(riskAudit.get(item.callId) ?? {}),
        ...(slot.execCtx.goalId ? { goalId: slot.execCtx.goalId } : {}),
        ...(slot.execCtx.activeTaskId ? { taskId: slot.execCtx.activeTaskId } : {}),
        ...(slot.execCtx.activeTaskItemId ? { taskItemId: slot.execCtx.activeTaskItemId } : {}),
      };
      ledger.toolIO.push(row);
      const turnRows = ledger.toolIO.filter((r) => r.turnId === turn.turnId);
      // Hint only: identical calls or identical repeated failures are flagged, never blocked.
      const repeated = repeatHint(turnRows);
      if (repeated) {
        row.return = { ...row.return, text: `${row.return.text}\n\n${repeated}` };
      }
      const escalation = escalate(turnRows, item.name);
      if (escalation.action === "force_end" || escalation.action === "interrupt") {
        saveLedger(dataDir, ledger);
        return { kind: "reply", text: escalation.text };
      }
      if (escalation.action === "hint") {
        row.return = { ...row.return, text: `${row.return.text}\n\n${escalation.text}` };
      }
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
      appendEvent(dataDir, ledger.conversationId, {
        kind: "tool",
        turnId: turn.turnId,
        data: { callId: item.callId, name: item.name, arguments: item.arguments, return: row.return, ...(row.images ? { images: row.images } : {}) },
      });
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
  body: { userInput: string; submittedAt: string },
): Promise<TurnReply> {
  const session = ensureSession(deps.dataDir);
  const host = deps.host?.forScope?.(session.conversationId) ?? deps.host;
  const ledger = loadLedger(deps.dataDir, session.conversationId);
  if (ledger.status === "running") {
    return {
      conversationId: ledger.conversationId,
      turnId: ledger.active?.turnId ?? "",
      stopReason: { kind: "error", faultCode: "busy" },
    };
  }
  const prevId = ledger.turnIds.at(-1);
  if (ledger.currentQuery) {
    ledger.queryHistory.push(ledger.currentQuery);
    ledger.currentQuery = null;
  }
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
    goalChanges: [],
    turnId,
    conversationId: ledger.conversationId,
    status: "assembling",
    createdAt: nowIso(),
    completedAt: null,
    input: { id: allocateRecordId(deps.dataDir, ledger.conversationId, "input"), text: body.userInput, submittedAt: body.submittedAt },
    assembled: assemble(toolRegistry, ledger.loadedToolIds),
    stopReason: null,
    usage: { modelRequests: 0, toolCalls: 0 },
  };
  saveContextRecord(deps.dataDir, ledger.conversationId, "userInput", inputRecord(turn));
  turn.assembled.conversationMemoryIds = [...ledger.memoryIds.conversation];
  turn.assembled.projectMemoryIds = loadMemories(deps.dataDir, ledger.conversationId, ledger.memoryIds).project.map(item => item.memoryId);
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
    let sendsSinceObservation = 0;
    let observationWrites = 0;
    let imageBatchId: string | undefined;
    while (true) {
      if (wasStopped(deps.dataDir, ledger.conversationId, turn.turnId)) {
          return stoppedReply(ledger, turn);
        }
      saveTurn(deps.dataDir, turn);
      const memories = loadMemories(deps.dataDir, ledger.conversationId, ledger.memoryIds);
      turn.assembled.projectMemoryIds = memories.project.map(item => item.memoryId);
      // Tool results already contain persisted image paths. Select attachments before
      // measuring/compressing text; only the preceding model response's batch is visual.
      const images: ChatMessage["images"] = imageBatchId === undefined ? [] : ledger.toolIO
        .filter(item => item.turnId === turn.turnId && item.batchId === imageBatchId)
        .flatMap(item => (item.images ?? []).map(image => ({ ...image, callId: item.callId })));
      // Nudge on model-send cadence: every 5 consecutive sends without observation.write.
      const writeCount = ledger.toolIO.filter((r) => r.turnId === turn.turnId && r.name === "observation.write").length;
      if (writeCount > observationWrites) {
        observationWrites = writeCount;
        sendsSinceObservation = 0;
      }
      sendsSinceObservation += 1;
      if (sendsSinceObservation > 0 && sendsSinceObservation % 5 === 0) {
        const rows = ledger.toolIO.filter((r) => r.turnId === turn.turnId);
        const last = rows.at(-1);
        if (last && !last.return.text.includes("建议用 observation.write")) {
          last.return = {
            ...last.return,
            text: `${last.return.text}\n\nruntime: 本回合已连续 ${sendsSinceObservation} 次模型请求未记录观察，建议用 observation.write 记录当前页面/代码/截图等观察后再继续。`,
          };
        }
      }
      let state = contextState(deps.dataDir, ledger, turn, memories);
      let messages = messagesOf(contextModules, toolRegistry, state.ledger, state.turn, state.memories, skillText, images, state.summaries, undefined, skillNav, deps.dataDir);
      const initialChars = windowChars(messages[0]!.content, messages[1]!.content);
      if (initialChars >= ledger.compressAt) {
        let compressionStarted = false;
        try {
          for (const phase of ["history", "current"] as const) {
            if (windowChars(messages[0]!.content, messages[1]!.content) < ledger.compressAt) break;
            const outcome = await compressContext({ ...deps, ledger, turn, memories, isCancelled: () => wasStopped(deps.dataDir, ledger.conversationId, turn.turnId), onStart: () => {
              if (!compressionStarted) appendEvent(deps.dataDir, ledger.conversationId, { kind: "compress-start", turnId, data: { windowChars: initialChars } });
              compressionStarted = true;
              appendEvent(deps.dataDir, ledger.conversationId, { kind: "compress-phase", turnId, data: { phase } });
            }, onProgress: (progress) => {
              compressionStarted = true;
              if (progress.type === "start") {
                appendEvent(deps.dataDir, ledger.conversationId, { kind: "compress-progress", turnId, data: { completed: 0, total: progress.total } });
                return;
              }
              if (progress.type === "turn") {
                appendEvent(deps.dataDir, ledger.conversationId, { kind: "compress-progress", turnId, data: { completed: progress.completed, total: progress.total, turnId: progress.turnId } });
                return;
              }
              appendEvent(deps.dataDir, ledger.conversationId, { kind: "compress-progress", turnId, data: { completed: progress.completed, total: progress.total, failedTurnId: progress.failedTurnId } });
            } }, phase);
            if (wasStopped(deps.dataDir, ledger.conversationId, turn.turnId)) {
          return stoppedReply(ledger, turn);
        }
            state = contextState(deps.dataDir, ledger, turn, memories);
            skillText = skillTextOf();
            messages = messagesOf(contextModules, toolRegistry, state.ledger, state.turn, state.memories, skillText, images, state.summaries, undefined, skillNav, deps.dataDir);
            // Sequential compression: a failed turn keeps originals; this boundary stops compressing and still sends the main model.
            if (outcome?.status === "stopped") break;
          }
          if (compressionStarted) appendEvent(deps.dataDir, ledger.conversationId, { kind: "compress", turnId, data: { beforeChars: initialChars, afterChars: windowChars(messages[0]!.content, messages[1]!.content) } });
        } catch (error) {
          if (wasStopped(deps.dataDir, ledger.conversationId, turn.turnId)) {
          return stoppedReply(ledger, turn);
        }
          turn.status = "failed";
          turn.completedAt = nowIso();
          const cause = errorInfo(error, "compression_failed");
          turn.stopReason = { kind: "error", faultCode: "compression_failed",
            ...(cause.faultCode !== "compression_failed" ? { causeCode: cause.faultCode } : {}),
            ...(cause.detail ? { detail: cause.detail } : {}) };
          ledger.status = "failed";
          ledger.active = null;
          saveTurn(deps.dataDir, turn);
          saveLedger(deps.dataDir, ledger);
          appendEvent(deps.dataDir, ledger.conversationId, { kind: "compress-error", turnId, data: { ...cause } });
          return { conversationId: ledger.conversationId, turnId, stopReason: turn.stopReason };
        }
      }
      // The send boundary first compresses at 200K, then externalizes notes first only
      // if the resulting view exceeds 250K. File publication precedes model dispatch.
      try {
        skillText = skillTextOf();
        messages = messagesOf(contextModules, toolRegistry, state.ledger, state.turn, state.memories, skillText, images, state.summaries, deps.dataDir, skillNav);
      } catch (error) {
        turn.status = "failed";
        turn.completedAt = nowIso();
        turn.stopReason = { kind: "error", faultCode: error instanceof ContextBudgetError ? "context_limit" : "context_storage_failed",
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
      saveTurn(deps.dataDir, turn);
      appendEvent(deps.dataDir, ledger.conversationId, {
        kind: "provider-request",
        turnId,
        data: { windowChars: ledger.windowChars, toolIds: [...turn.assembled.baseToolsIds, ...turn.assembled.toolIds], usage: { ...turn.usage } },
      });
      const providerResult = await deps.provider.complete({
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
      const batchId = rawResult.toolCalls.length || rawResult.toolCallFaults?.length
        ? allocateRecordId(deps.dataDir, ledger.conversationId, "batch") : undefined;
      imageBatchId = batchId;
      const { result, batch: batchCheck, checks, validCalls } = validateCompletion(
        rawResult, tools, turn.assembled.baseToolsIds, turn.assembled.toolIds,
      );
      const toolIds = [...turn.assembled.baseToolsIds, ...turn.assembled.toolIds];
      appendProviderExchange(deps.dataDir, ledger.conversationId, {
        turnId,
        messages,
        content: result.content,
        request: { toolIds },
        response: {
          providerCallIds,
          finish: result.finish,
          toolCalls: result.toolCalls,
          attempts: result.attempts,
          parseOk: result.parseOk,
          schemaOk: result.schemaOk,
          faultCode: result.faultCode,
          missing: result.missing,
          badName: result.badName,
          detail: result.detail ?? "",
        },
      });
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
          });
          if (wasStopped(deps.dataDir, ledger.conversationId, turn.turnId, ledger.status)) {
          return stoppedReply(ledger, turn);
        }
          if (batchId) {
            const observationByCall = new Map(
              turn.assembled.observations
                .filter((item) => item.turnId === turn.turnId)
                .map((item) => [item.callId, item.id] as const),
            );
            ledger.lastAction = {
              batchId,
              turnId,
              calls: result.toolCalls.map((call) => ({
                callId: call.id,
                name: call.name,
                ...(observationByCall.has(call.id) ? { observationId: observationByCall.get(call.id)! } : {}),
              })),
            };
          }
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
          const autoBatchId = allocateRecordId(deps.dataDir, ledger.conversationId, "batch");
          ledger.toolQueue = [{
            batchId: autoBatchId,
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
          });
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
      });
      if (wasStopped(deps.dataDir, ledger.conversationId, turn.turnId, ledger.status)) {
          return stoppedReply(ledger, turn);
        }
      if (batchId) {
        const observationByCall = new Map(
          turn.assembled.observations
            .filter((item) => item.turnId === turn.turnId)
            .map((item) => [item.callId, item.id] as const),
        );
        ledger.lastAction = {
          batchId,
          turnId,
          calls: result.toolCalls.map((call) => ({
            callId: call.id,
            name: call.name,
            ...(observationByCall.has(call.id) ? { observationId: observationByCall.get(call.id)! } : {}),
          })),
        };
      }
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
    const cause = errorInfo(error);
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
