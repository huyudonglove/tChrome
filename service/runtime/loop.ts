import { saveContextRecord } from "./records.ts";
import { allocateRecordId, inputRecord } from "./ids.ts";
import { loadMemories } from "../memory/store.ts";
import { storeToolImages } from "../images/tool-result.ts";
import { admitImages, admitText, deferredImageNote } from "../admission.ts";
import { ensureThumb, loadThumbRef } from "../images/thumb.ts";
import { projectMemories } from "../memory/window.ts";
import { errorInfo, errorMessage } from "../../shared/errors.ts";
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
  TurnOutput,
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
  saveLedger,
  saveTurn,
  appendEvent,
  appendProviderExchange,
} from "./store.ts";

// stopTurn already persists cancellation. A superseded worker must never write
// its stale ledger back over a newer turn (or recreate a deleted conversation).
const stoppedReply = (ledger: Ledger, turn: Turn): TurnReply => ({
  conversationId: ledger.conversationId,
  turnId: turn.turnId,
  output: { kind: "error", faultCode: "stopped" },
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
  pageObservedHistory: [],
  openTabs: { ok: false, error: "尚未读取标签列表" },
});

const messagesOf = (contextModules: ContextModules, toolRegistry: ToolRegistry, ledger: Ledger, turn: Turn, memories: ReturnType<typeof loadMemories>, skillText: string, images: ChatMessage["images"], summaries: Parameters<typeof userText>[0]["conversationSummaries"] = [], dataDir?: string, skillNav = ""): ChatMessage[] => {
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
  const text = JSON.stringify(toolFailure({
    ok: false,
    faultCode: result.faultCode,
    missing: result.missing,
    toolName: name,
    detail: result.detail ?? "",
    details: { parameterSchema: tools.find(tool => tool.function.name === name)?.function.parameters },
  }));
  ledger.toolIO.push({
    callId: call?.id ?? allocateRecordId(dataDir, ledger.conversationId, "call"),
    name,
    turnId,
    arguments: call?.arguments ?? {},
    return: { stage: "complete", totalChars: text.length, text },
  });
};

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
}): Promise<TurnOutput | null> => {
  const { dataDir, ledger, turn, toolRegistry, host, browserNames } = input;
  while (ledger.toolQueue.length) {
    const item = ledger.toolQueue.shift();
    if (!item) break;
    if (wasStopped(dataDir, ledger.conversationId, turn.turnId)) {
      return { kind: "error", faultCode: "stopped" };
    }
    ledger.liveTool = { name: item.name, callId: item.callId };
    saveLedger(dataDir, ledger);
    turn.usage ??= { modelRequests: 0, toolCalls: 0 };
    turn.usage.toolCalls += 1;
    saveTurn(dataDir, turn);
    let execution: ToolExecution;
    try {
      execution = await executeTool({
        name: item.name,
        arguments: item.arguments,
        dataDir,
        conversationId: ledger.conversationId,
        browserNames,
        goalContext: { goals: ledger.goals, currentGoalId: ledger.currentGoalId, turnId: turn.turnId, sourceCallId: item.callId },
        host,
        signal: input.signal,
        pageObservationIds: turn.assembled.pageObservedHistory.map((row) => row.id),
        defaultTabId: ledger.contextTab?.tabId ?? null,
        queryContext: args => queryContext({ dataDir, conversationId: ledger.conversationId, repoRoot: input.repoRoot, provider: input.provider, ...args, isCancelled: () => wasStopped(dataDir, ledger.conversationId, turn.turnId) }),
        lookup: {
          knownTools: Object.keys(toolRegistry.tools),
          enabledTools: [...turn.assembled.toolIds, ...toolRegistry.toolGroups.baseToolsIds],
          unusedTools: dynamicToolIds(toolRegistry).filter((id) => !turn.assembled.toolIds.includes(id)),
        },
      });
    } catch (error) {
      // A failed tool is evidence for the model to correct its next call. It must
      // pass through the same recording/effect boundary as any normal result.
      execution = failedTool(error, "tool_execution_failed", { toolName: item.name });
    }
    if (wasStopped(dataDir, ledger.conversationId, turn.turnId)) {
      return { kind: "error", faultCode: "stopped" };
    }
    const observed = (([...turn.assembled.pageObservedHistory].reverse().find((row) => row.callId === item.callId)?.result ?? {}) as { url?: string; title?: string });
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
    // Oversized returns stay on disk; the window only gets a searchable pointer.
    const admittedText = admitText(full, {
      callId: item.callId,
      name: item.name,
      path: join(paths(dataDir, ledger.conversationId).returns, `${item.callId}.txt`),
    });
    const viewText = admittedText.mode === "inline" ? admittedText.text : JSON.stringify(admittedText.payload);
    const row: ToolIOItem = {
      ...item,
      turnId: turn.turnId,
      ...(stored.images.length ? { images: stored.images } : {}),
      return: { stage: "complete", totalChars: full.length, text: viewText },
    };
    ledger.toolIO.push(row);
    let output: TurnOutput | null = null;
    try {
      output = applyToolEffects({ dataDir, ledger, turn, call: item, effects: execution.effects });
    } catch (error) {
      if (wasStopped(dataDir, ledger.conversationId, turn.turnId)) return { kind: "error", faultCode: "stopped" };
      // Effects can fail after earlier writes succeeded. Report evidence without replaying them.
      const text = failedTool(error, "tool_execution_failed", { toolName: item.name,
        details: { executionState: "部分操作可能已生效，请先检查已保存记录与当前状态，不要直接重放整批操作。" } }).text;
      row.return = { stage: "complete", totalChars: text.length, text };
      saveFullReturn(dataDir, ledger.conversationId, item.callId, text);
      ledger.liveTool = null;
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
      output: { kind: "error", faultCode: "busy" },
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
    output: null,
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
  ledger.checklist = null;
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
    let imageBatchId: string | undefined;
    while (true) {
      if (wasStopped(deps.dataDir, ledger.conversationId, turn.turnId)) {
          ledger.checklist = null;
          return stoppedReply(ledger, turn);
        }
      try {
        const tabs = host?.readOpenTabs ? await host.readOpenTabs() : { ok: false as const, error: "浏览器宿主不可用，无法读取标签列表" };
        turn.assembled.openTabs = tabs.ok ? tabs : { ok: false, error: tabs.error || "标签列表读取失败" };
      } catch (error) {
        turn.assembled.openTabs = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (wasStopped(deps.dataDir, ledger.conversationId, turn.turnId)) {
          ledger.checklist = null;
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
      let state = contextState(deps.dataDir, ledger, turn, memories);
      let messages = messagesOf(contextModules, toolRegistry, state.ledger, state.turn, state.memories, skillText, images, state.summaries, undefined, skillNav);
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
          ledger.checklist = null;
          return stoppedReply(ledger, turn);
        }
            state = contextState(deps.dataDir, ledger, turn, memories);
            skillText = skillTextOf();
            messages = messagesOf(contextModules, toolRegistry, state.ledger, state.turn, state.memories, skillText, images, state.summaries, undefined, skillNav);
            // Sequential compression: a failed turn keeps originals; this boundary stops compressing and still sends the main model.
            if (outcome?.status === "stopped") break;
          }
          if (compressionStarted) appendEvent(deps.dataDir, ledger.conversationId, { kind: "compress", turnId, data: { beforeChars: initialChars, afterChars: windowChars(messages[0]!.content, messages[1]!.content) } });
        } catch (error) {
          if (wasStopped(deps.dataDir, ledger.conversationId, turn.turnId)) {
          ledger.checklist = null;
          return stoppedReply(ledger, turn);
        }
          turn.status = "failed";
          turn.completedAt = nowIso();
          const cause = errorInfo(error, "compression_failed");
          turn.output = { kind: "error", faultCode: "compression_failed",
            ...(cause.faultCode !== "compression_failed" ? { causeCode: cause.faultCode } : {}),
            ...(cause.detail ? { detail: cause.detail } : {}) };
          ledger.status = "failed";
        ledger.checklist = null;
          ledger.active = null;
          saveTurn(deps.dataDir, turn);
          saveLedger(deps.dataDir, ledger);
          appendEvent(deps.dataDir, ledger.conversationId, { kind: "compress-error", turnId, data: { ...cause } });
          return { conversationId: ledger.conversationId, turnId, output: turn.output };
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
        turn.output = { kind: "error", faultCode: error instanceof ContextBudgetError ? "context_limit" : "context_storage_failed",
          detail: error instanceof Error ? error.message : String(error) };
        ledger.checklist = null;
        ledger.status = "failed";
        ledger.checklist = null;
        ledger.active = null;
        saveTurn(deps.dataDir, turn);
        saveLedger(deps.dataDir, ledger);
        appendEvent(deps.dataDir, ledger.conversationId, { kind: "context-budget-error", turnId, data: { detail: String(error) } });
        return { conversationId: ledger.conversationId, turnId, output: turn.output };
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
      });
      if (wasStopped(deps.dataDir, ledger.conversationId, turn.turnId)) {
          ledger.checklist = null;
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
        turn.output = { kind: "error", faultCode: result.faultCode ?? "provider_error",
          ...(result.detail ? { detail: result.detail } : {}) };
        ledger.checklist = null;
        ledger.status = "failed";
        ledger.checklist = null;
        ledger.active = null;
        ledger.liveTool = null;
        saveTurn(deps.dataDir, turn);
        saveLedger(deps.dataDir, ledger);
        appendEvent(deps.dataDir, ledger.conversationId, {
          kind: "turn-output",
          turnId,
          data: { output: turn.output },
        });
        return { conversationId: ledger.conversationId, turnId, output: turn.output };
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
            toolCalls: [{ id: fault.callId, name: fault.name, arguments: { rawArguments: fault.rawArguments } }],
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
          ledger.checklist = null;
          return stoppedReply(ledger, turn);
        }
          if (batchId) {
            const observationByCall = new Map(
              turn.assembled.pageObservedHistory
                .filter((item) => item.turnId === turn.turnId)
                .map((item) => [item.callId, item.id] as const),
            );
            ledger.lastAction = {
              batchId,
              turnId,
              calls: result.toolCalls.map((call) => ({
                callId: call.id,
                name: call.name,
                ...(observationByCall.has(call.id) ? { pageObservationId: observationByCall.get(call.id)! } : {}),
              })),
            };
          }
          saveTurn(deps.dataDir, turn);
          saveLedger(deps.dataDir, ledger);
          if (closed) {
            appendEvent(deps.dataDir, ledger.conversationId, {
              kind: "turn-output",
              turnId,
              data: { output: closed },
            });
            return { conversationId: ledger.conversationId, turnId, output: closed };
          }
        }
        if (submitFails >= MAX_SUBMIT) {
          turn.status = "failed";
          turn.completedAt = nowIso();
          turn.output = { kind: "error", faultCode: result.faultCode ?? "missing_required",
            toolName: result.badName, detail: result.detail };
          ledger.status = "failed";
        ledger.checklist = null;
          ledger.active = null;
          ledger.liveTool = null;
          saveTurn(deps.dataDir, turn);
          saveLedger(deps.dataDir, ledger);
          appendEvent(deps.dataDir, ledger.conversationId, {
            kind: "turn-output",
            turnId,
            data: { output: turn.output },
          });
          return { conversationId: ledger.conversationId, turnId, output: turn.output };
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
              kind: "turn-output",
              turnId,
              data: { output: closed },
            });
            return { conversationId: ledger.conversationId, turnId, output: closed };
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
          turn.output = { kind: "error", faultCode: "need_finish_turn" };
          ledger.status = "failed";
        ledger.checklist = null;
          ledger.active = null;
          ledger.liveTool = null;
          saveTurn(deps.dataDir, turn);
          saveLedger(deps.dataDir, ledger);
          appendEvent(deps.dataDir, ledger.conversationId, {
            kind: "turn-output",
            turnId,
            data: { output: turn.output },
          });
          return { conversationId: ledger.conversationId, turnId, output: turn.output };
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
          ledger.checklist = null;
          return stoppedReply(ledger, turn);
        }
      if (batchId) {
        const observationByCall = new Map(
          turn.assembled.pageObservedHistory
            .filter((item) => item.turnId === turn.turnId)
            .map((item) => [item.callId, item.id] as const),
        );
        ledger.lastAction = {
          batchId,
          turnId,
          calls: result.toolCalls.map((call) => ({
            callId: call.id,
            name: call.name,
            ...(observationByCall.has(call.id) ? { pageObservationId: observationByCall.get(call.id)! } : {}),
          })),
        };
      }
      saveTurn(deps.dataDir, turn);
      saveLedger(deps.dataDir, ledger);
      if (closed) {
        appendEvent(deps.dataDir, ledger.conversationId, {
          kind: "turn-output",
          turnId,
          data: { output: closed },
        });
        return { conversationId: ledger.conversationId, turnId, output: closed };
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
    turn.output = { kind: "error", faultCode: "empty_finish_turn" };
    ledger.status = "failed";
        ledger.checklist = null;
    ledger.active = null;
    ledger.liveTool = null;
    ledger.toolQueue = [];
    saveTurn(deps.dataDir, turn);
    saveLedger(deps.dataDir, ledger);
    appendEvent(deps.dataDir, ledger.conversationId, {
      kind: "turn-output",
      turnId,
      data: { output: turn.output },
    });
    return { conversationId: ledger.conversationId, turnId, output: turn.output };
  } catch (error) {
    if (wasStopped(deps.dataDir, ledger.conversationId, turn.turnId)) {
          ledger.checklist = null;
          return stoppedReply(ledger, turn);
        }
    const cause = errorInfo(error);
    const liveTool = ledger.liveTool;
    turn.status = "failed";
    turn.completedAt = nowIso();
    turn.output = { kind: "error", faultCode: "tool_execution_failed", detail: cause.detail,
      ...(cause.faultCode !== "tool_execution_failed" ? { causeCode: cause.faultCode } : {}),
      ...(liveTool ? { toolName: liveTool.name } : {}) };
    ledger.status = "failed";
        ledger.checklist = null;
    ledger.active = null;
    ledger.liveTool = null;
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
      kind: "turn-output", turnId,
      data: { output: turn.output, ...(liveTool ? { callId: liveTool.callId } : {}),
        error: { ...cause, ...(error instanceof Error ? { stack: error.stack } : {}) } },
    });
    return { conversationId: ledger.conversationId, turnId, output: turn.output };
  } finally { execution.finish(); }
}
