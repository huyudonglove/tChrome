import { saveContextRecord } from "./records.ts";
import { allocateRecordId, idPrefix, inputRecord } from "./ids.ts";
import { loadMemories } from "../memory/store.ts";
import { storeToolImages } from "../images/tool-result.ts";
import { projectMemories } from "../memory/window.ts";
import runtimeMessages from "./messages.json";
import { systemText, userText, windowChars } from "../context/window.ts";
import { loadSkills } from "../skills/loader.ts";
import { loadContextModules, type ContextModules } from "../context/modules.ts";
import { loadToolRegistry, coreToolIds, dynamicToolIds, toolSchemas, toolUsageFor, type ToolRegistry } from "../tools/registry.ts";
import { executeTool } from "../tools/execute.ts";
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
import { nextId, nowIso, pacificDate } from "./ids.ts";
import {
  ensureSession,
  loadLedger,
  loadTurn,
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
};

const assemble = (toolRegistry: ToolRegistry): Assembled => ({
  baseToolsIds: [...toolRegistry.toolGroups.baseToolsIds],
  toolIds: coreToolIds(toolRegistry),

  conversationMemoryIds: [],
  projectMemoryIds: [],
  mcpIds: [],
  currentPage: null,
  pageObservedHistory: [],
  currentTab: null,
});

const messagesOf = (contextModules: ContextModules, toolRegistry: ToolRegistry, ledger: Ledger, turn: Turn, memories: ReturnType<typeof loadMemories>, skillText: string, summaries: Parameters<typeof userText>[0]["conversationSummaries"] = []): ChatMessage[] => [
  { role: "system", content: systemText(contextModules, toolUsageFor(toolRegistry, turn.assembled.baseToolsIds), pacificDate()) },
  { role: "user", content: userText({
    contextModules, ledger, turn, memories: projectMemories(memories), skillText, conversationSummaries: summaries,
    toolUsage: toolUsageFor(toolRegistry, turn.assembled.toolIds),
  }), images: [...new Map(ledger.toolIO.filter(item => item.turnId === turn.turnId)
    .flatMap(item => item.images ?? []).reverse().map(image => [image.id, image])).values()].slice(0, 4).reverse() },
];

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
    validCalls: batch.faultCode === "exclusive_resident" ? [] : checks.filter(({ check }) => check.schemaOk).map(({ call }) => call),
  };
};

const writeFault = (dataDir: string, ledger: Ledger, turnId: string, result: CompletionResult) => {
  const name = result.badName || result.toolCalls.at(-1)?.name || "unknown";
  const call = result.toolCalls.find((row) => row.name === name) ?? result.toolCalls.at(-1);
  const text = JSON.stringify({
    ok: false,
    faultCode: result.faultCode,
    missing: result.missing,
    toolName: name,
    detail: result.detail ?? "",
  });
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
  content: string;
  browserNames: string[];
  host?: BrowserHost;
  provider: Provider;
  repoRoot: string;
}): Promise<TurnOutput | null> => {
  const { dataDir, ledger, turn, toolRegistry, content, host, browserNames } = input;
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
    const execution = await executeTool({
      name: item.name,
      arguments: item.arguments,
      content,
      dataDir,
      conversationId: ledger.conversationId,
      browserNames,
      host,
      queryContext: args => queryContext({ dataDir, conversationId: ledger.conversationId, repoRoot: input.repoRoot, provider: input.provider, ...args, isCancelled: () => wasStopped(dataDir, ledger.conversationId, turn.turnId) }),
      lookup: {
        knownTools: Object.keys(toolRegistry.tools),
        enabledTools: [...turn.assembled.toolIds, ...toolRegistry.toolGroups.baseToolsIds],
        unusedTools: dynamicToolIds(toolRegistry).filter((id) => !turn.assembled.toolIds.includes(id)),
      },
    });
    if (wasStopped(dataDir, ledger.conversationId, turn.turnId)) {
      return { kind: "error", faultCode: "stopped" };
    }
    const stored = storeToolImages(dataDir, ledger.conversationId, execution.text);
    const full = stored.text;
    saveFullReturn(dataDir, ledger.conversationId, item.callId, full);
    const row: ToolIOItem = {
      ...item,
      turnId: turn.turnId,
      ...(stored.images.length ? { images: stored.images } : {}),
      return: { stage: "complete", totalChars: full.length, text: full },
    };
    ledger.toolIO.push(row);
    appendEvent(dataDir, ledger.conversationId, {
      kind: "tool",
      turnId: turn.turnId,
      data: { callId: item.callId, name: item.name, arguments: item.arguments, return: row.return, ...(row.images ? { images: row.images } : {}) },
    });
    const output = applyToolEffects({ dataDir, ledger, turn, call: item, effects: execution.effects });
    if (output) return output;
  }
  return null;
};

export async function handleTurn(
  deps: LoopDeps,
  body: { userInput: string; submittedAt: string; currentTab?: { tab?: number; url?: string; title?: string } | null },
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
  if (prevId) {
    const last = loadTurn(deps.dataDir, ledger.conversationId, prevId);
    ledger.userInputHistory.push(inputRecord(last));
  }
  const contextModules = loadContextModules(deps.repoRoot);
  const skillText = loadSkills(deps.repoRoot);
  const toolRegistry = loadToolRegistry(deps.repoRoot);
  const turnId = nextId(idPrefix("turn"), ledger.turnIds);
  const turn: Turn = {
    turnId,
    conversationId: ledger.conversationId,
    status: "assembling",
    createdAt: nowIso(),
    completedAt: null,
    input: { id: allocateRecordId(deps.dataDir, ledger.conversationId, "input"), text: body.userInput, submittedAt: body.submittedAt },
    assembled: assemble(toolRegistry),
    output: null,
    usage: { modelRequests: 0, toolCalls: 0 },
  };
  saveContextRecord(deps.dataDir, ledger.conversationId, "userInput", inputRecord(turn));
  const tab = body.currentTab;
  const tabId = Number(tab?.tab);
  if (tab && Number.isFinite(tabId) && tabId >= 1) {
    turn.assembled.currentTab = {
      tab: tabId,
      url: String(tab.url ?? ""),
      title: String(tab.title ?? ""),
    };
    turn.assembled.currentPage = { ...turn.assembled.currentTab, description: "用户发话时的标签信息，尚未读取页面内容" };
  }
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
  let submitFails = 0;
  while (true) {
    if (wasStopped(deps.dataDir, ledger.conversationId, turn.turnId)) return stoppedReply(ledger, turn);
    const memories = loadMemories(deps.dataDir, ledger.conversationId, ledger.memoryIds);
    turn.assembled.projectMemoryIds = memories.project.map(item => item.memoryId);
    let state = contextState(deps.dataDir, ledger, turn, memories);
    let messages = messagesOf(contextModules, toolRegistry, state.ledger, state.turn, state.memories, skillText, state.summaries);
    const initialChars = windowChars(messages[0]!.content, messages[1]!.content);
    if (initialChars >= ledger.compressAt) {
      appendEvent(deps.dataDir, ledger.conversationId, { kind: "compress-start", turnId, data: { windowChars: initialChars } });
      try {
        for (const phase of ["history", "current", "summaries"] as const) {
          if (windowChars(messages[0]!.content, messages[1]!.content) < ledger.compressAt) break;
          await compressContext({ ...deps, ledger, turn, memories, isCancelled: () => wasStopped(deps.dataDir, ledger.conversationId, turn.turnId) }, phase);
          if (wasStopped(deps.dataDir, ledger.conversationId, turn.turnId)) return stoppedReply(ledger, turn);
          state = contextState(deps.dataDir, ledger, turn, memories);
          messages = messagesOf(contextModules, toolRegistry, state.ledger, state.turn, state.memories, skillText, state.summaries);
        }
        appendEvent(deps.dataDir, ledger.conversationId, { kind: "compress", turnId, data: { beforeChars: initialChars, afterChars: windowChars(messages[0]!.content, messages[1]!.content) } });
      } catch (error) {
        if (wasStopped(deps.dataDir, ledger.conversationId, turn.turnId)) return stoppedReply(ledger, turn);
        turn.status = "failed";
        turn.completedAt = nowIso();
        turn.output = { kind: "error", faultCode: "compression_failed" };
        ledger.status = "failed";
        ledger.active = null;
        saveTurn(deps.dataDir, turn);
        saveLedger(deps.dataDir, ledger);
        appendEvent(deps.dataDir, ledger.conversationId, { kind: "compress-error", turnId, data: { detail: String(error) } });
        return { conversationId: ledger.conversationId, turnId, output: turn.output };
      }
    }
    ledger.windowChars = windowChars(messages[0]!.content, messages[1]!.content);
    if (ledger.windowChars >= ledger.compressAt) {
      turn.status = "failed";
      turn.completedAt = nowIso();
      turn.output = { kind: "error", faultCode: "context_limit" };
      ledger.status = "failed";
      ledger.active = null;
      saveTurn(deps.dataDir, turn);
      saveLedger(deps.dataDir, ledger);
      return { conversationId: ledger.conversationId, turnId, output: turn.output };
    }
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
    if (wasStopped(deps.dataDir, ledger.conversationId, turn.turnId)) return stoppedReply(ledger, turn);
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
      turn.output = { kind: "error", faultCode: result.faultCode ?? "provider_error" };
      ledger.status = "failed";
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
    if (!result.parseOk || !result.schemaOk) {
      submitFails += 1;
      if (result.toolCallFaults?.length) {
        for (const fault of result.toolCallFaults) {
          writeFault(deps.dataDir, ledger, turnId, {
            ...result,
            badName: fault.name,
            detail: fault.detail,
            toolCalls: [{ id: fault.callId, name: fault.name, arguments: { rawArguments: fault.rawArguments } }],
          });
        }
      } else {
        writeFault(deps.dataDir, ledger, turnId, result);
      }
      for (const { call, check } of checks) {
        if (batchCheck.faultCode === "exclusive_resident") break;
        if (!check.schemaOk && (result.toolCallFaults?.length || call.name !== result.badName)) {
          writeFault(deps.dataDir, ledger, turnId, { ...result, ...check, toolCalls: [call] });
        }
      }
      if (!result.parseOk && batchCheck.faultCode === "exclusive_resident") {
        writeFault(deps.dataDir, ledger, turnId, { ...result, ...batchCheck });
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
          content: result.content,
          provider: deps.provider, repoRoot: deps.repoRoot,
          browserNames: toolRegistry.index.browser,
          host,
        });
        if (wasStopped(deps.dataDir, ledger.conversationId, turn.turnId, ledger.status)) return stoppedReply(ledger, turn);
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
        turn.output = { kind: "error", faultCode: result.faultCode ?? "missing_required" };
        ledger.status = "failed";
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
      submitFails += 1;
      ledger.toolIO.push({
        callId: allocateRecordId(deps.dataDir, ledger.conversationId, "call"),
        name: "finishTurn",
        turnId,
        arguments: {},
        return: { stage: "complete", totalChars: runtimeMessages.needFinishTurn.length, text: runtimeMessages.needFinishTurn },
      });
      if (submitFails >= MAX_SUBMIT) {
        turn.status = "failed";
        turn.completedAt = nowIso();
        turn.output = { kind: "error", faultCode: "need_finish_turn" };
        ledger.status = "failed";
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
      content: result.content,
      provider: deps.provider, repoRoot: deps.repoRoot,
      browserNames: toolRegistry.index.browser,
      host,
    });
    if (wasStopped(deps.dataDir, ledger.conversationId, turn.turnId, ledger.status)) return stoppedReply(ledger, turn);
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
}
