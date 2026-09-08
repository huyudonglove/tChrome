import { systemText, userText, windowChars } from "../context/window.ts";
import { coreToolIds, dynamicToolIds, loadCatalog, toolSchemas, toolUsageFor, type Catalog } from "../prompt/catalog.ts";
import { asObject, asStringArray, clipReturn, executeTool, pageFromBrowser } from "../tools/execute.ts";
import type {
  Assembled,
  BrowserHost,
  ChatMessage,
  CompletionResult,
  Ledger,
  MemoryRecord,
  Provider,
  ToolCall,
  ToolIOItem,
  Turn,
  TurnOutput,
  TurnReply,
} from "../types.ts";
import { checkToolCalls } from "../tools/schema.ts";
import { maybeCompress } from "./compress.ts";
import { nextId, nowIso } from "./ids.ts";
import {
  ensureSession,
  loadLedger,
  loadMemory,
  loadObservation,
  loadTurn,
  loadFullReturn,
  saveFullReturn,
  saveLedger,
  saveMemory,
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

const wasStopped = (dataDir: string, conversationId: string, turnId: string) => {
  const current = loadLedger(dataDir, conversationId);
  return current.status !== "running" || current.active?.turnId !== turnId;
};

const MAX_SUBMIT = 3;

export type LoopDeps = {
  dataDir: string;
  repoRoot: string;
  provider: Provider;
  host?: BrowserHost;
};

const assemble = (catalog: Catalog): Assembled => ({
  systemIds: [...catalog.assemble.systemIds],
  skillIds: [...catalog.assemble.skillIds],
  baseToolsIds: [...catalog.assemble.baseToolsIds],
  toolIds: coreToolIds(catalog),
  turnMemoryIds: [],
  conversationMemoryIds: [],
  projectMemoryIds: [],
  mcpIds: [],
  currentPage: null,
  currentTab: null,
});

const loadMemories = (dataDir: string, ledger: Ledger) => {
  const read = (ids: string[]) => ids.map((id) => loadMemory(dataDir, ledger.conversationId, id));
  return {
    project: read(ledger.memoryIds.project),
    conversation: read(ledger.memoryIds.conversation),
    turn: read(ledger.memoryIds.turn),
  };
};

const messagesOf = (catalog: Catalog, ledger: Ledger, turn: Turn, dataDir: string): ChatMessage[] => {
  const system = systemText(catalog);
  const user = userText({
    catalog,
    ledger,
    turn,
    memories: loadMemories(dataDir, ledger),
    baseToolUsage: toolUsageFor(catalog, turn.assembled.baseToolsIds),
    toolUsage: toolUsageFor(catalog, turn.assembled.toolIds),
  });
  maybeCompress({
    dataDir,
    ledger,
    turn,
    catalog,
    coreToolIds: coreToolIds(catalog),
    windowChars: windowChars(system, user),
  });
  const userAfter = userText({
    catalog,
    ledger,
    turn,
    memories: loadMemories(dataDir, ledger),
    baseToolUsage: toolUsageFor(catalog, turn.assembled.baseToolsIds),
    toolUsage: toolUsageFor(catalog, turn.assembled.toolIds),
  });
  return [
    { role: "system", content: system },
    { role: "user", content: userAfter },
  ];
};

const writeFault = (ledger: Ledger, turnId: string, result: CompletionResult) => {
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
    callId: call?.id ?? "call_fault",
    name,
    turnId,
    arguments: call?.arguments ?? {},
    return: clipReturn(text),
  });
};

const persistMemory = (dataDir: string, ledger: Ledger, call: ToolCall) => {
  const writeLayer = (layer: "turn" | "conversation" | "project", texts: string[]) => {
    for (const text of texts) {
      const memoryId = nextId("mm_", [
        ...ledger.memoryIds.turn,
        ...ledger.memoryIds.conversation,
        ...ledger.memoryIds.project,
      ]);
      const record: MemoryRecord = {
        memoryId,
        layer,
        text,
        summary: text.slice(0, 40),
        compressed: false,
        createdAt: nowIso(),
        sourceCallId: call.id,
      };
      saveMemory(dataDir, ledger.conversationId, record);
      ledger.memoryIds[layer].push(memoryId);
      appendEvent(dataDir, ledger.conversationId, {
        kind: "memory",
        data: { memoryId, layer, sourceCallId: call.id },
      });
    }
  };
  writeLayer("turn", asStringArray(call.arguments.turnMemory));
  writeLayer("conversation", asStringArray(call.arguments.conversationMemory));
  writeLayer("project", asStringArray(call.arguments.projectMemory));
  const summary = asObject(call.arguments.contextSummary);
  if (summary) ledger.contextSummary = summary;
};

const runQueue = async (input: {
  dataDir: string;
  ledger: Ledger;
  turn: Turn;
  catalog: Catalog;
  content: string;
  browserNames: string[];
  host?: BrowserHost;
}): Promise<TurnOutput | null> => {
  const { dataDir, ledger, turn, catalog, content, host, browserNames } = input;
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
    const full = await executeTool({
      name: item.name,
      arguments: item.arguments,
      content,
      dataDir,
      browserNames,
      host,
      lookup: {
        toolIO: ledger.toolIO,
        fullReturn: (callId) => loadFullReturn(dataDir, ledger.conversationId, callId),
        observationFull: (observationId) =>
          loadObservation(dataDir, ledger.conversationId, observationId)?.full ?? null,
        unusedTools: dynamicToolIds(catalog).filter((id) => !turn.assembled.toolIds.includes(id)),
      },
    });
    if (wasStopped(dataDir, ledger.conversationId, turn.turnId)) {
      return { kind: "error", faultCode: "stopped" };
    }
    saveFullReturn(dataDir, ledger.conversationId, item.callId, full);
    const row: ToolIOItem = {
      ...item,
      turnId: turn.turnId,
      return: clipReturn(full),
    };
    ledger.toolIO.push(row);
    appendEvent(dataDir, ledger.conversationId, {
      kind: "tool",
      turnId: turn.turnId,
      data: { callId: item.callId, name: item.name, arguments: item.arguments, return: row.return },
    });
    try {
      const parsed = JSON.parse(full) as { ok?: boolean; tab?: number; url?: string; title?: string; description?: string };
      const page = pageFromBrowser(parsed);
      if (page) turn.assembled.currentPage = page;
    } catch {
      // resident tools return plain text
    }
    if (item.name === "memory.write") {
      persistMemory(dataDir, ledger, { id: item.callId, name: item.name, arguments: item.arguments });
    }
    if (item.name === "submitGoal") {
      const goal = String(item.arguments.goal ?? "").trim();
      if (goal && goal !== ledger.goal) {
        if (ledger.goal) ledger.goalHistory.push(ledger.goal);
        ledger.goal = goal;
      }
    }
    if (item.name === "notes.write") {
      const key = String(item.arguments.key ?? "").trim();
      if (key) ledger.notes[key] = String(item.arguments.value ?? "");
    }
    if (item.name === "notes.delete") {
      const key = String(item.arguments.key ?? "").trim();
      if (key) delete ledger.notes[key];
    }
    if (item.name === "catalog.add") {
      const names = asStringArray(item.arguments.names);
      for (const name of names) {
        if (turn.assembled.toolIds.includes(name)) continue;
        if (!catalog.tools[name]) continue;
        if (catalog.assemble.baseToolsIds.includes(name)) continue;
        turn.assembled.toolIds.push(name);
      }
    }
    if (item.name === "askUser") {
      turn.status = "waiting_human";
      turn.completedAt = nowIso();
      turn.output = { kind: "ask", question: full };
      ledger.status = "waiting_human";
      ledger.pendingAsk = { turnId: turn.turnId, question: full };
      ledger.active = { turnId: turn.turnId };
      ledger.liveTool = null;
      return turn.output;
    }
    if (item.name === "finishTurn") {
      if (!full.trim()) {
        ledger.toolQueue = [];
        ledger.liveTool = null;
        ledger.toolIO.push({
          ...item,
          turnId: turn.turnId,
          return: clipReturn(catalog.assemble.messages.emptyFinishTurn),
        });
        return null;
      }
      turn.status = "completed";
      turn.completedAt = nowIso();
      turn.output = { kind: "reply", text: full };
      ledger.status = "idle";
      ledger.active = null;
      ledger.pendingAsk = null;
      ledger.toolQueue = [];
      ledger.liveTool = null;
      return turn.output;
    }
  }
  return null;
};

export async function handleTurn(
  deps: LoopDeps,
  body: { userInput: string; submittedAt: string; currentTab?: { tab?: number; url?: string; title?: string } | null },
): Promise<TurnReply> {
  const session = ensureSession(deps.dataDir);
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
    ledger.userInputHistory.push(last.input.text);
  }
  const catalog = loadCatalog(deps.repoRoot);
  const turnId = nextId("tn_", ledger.turnIds);
  const turn: Turn = {
    turnId,
    conversationId: ledger.conversationId,
    status: "assembling",
    createdAt: nowIso(),
    completedAt: null,
    input: { text: body.userInput, submittedAt: body.submittedAt },
    assembled: assemble(catalog),
    output: null,
    usage: { modelRequests: 0, toolCalls: 0 },
  };
  const tab = body.currentTab;
  const tabId = Number(tab?.tab);
  if (tab && Number.isFinite(tabId) && tabId >= 1) {
    turn.assembled.currentTab = {
      tab: tabId,
      url: String(tab.url ?? ""),
      title: String(tab.title ?? ""),
    };
  }
  turn.assembled.turnMemoryIds = [...ledger.memoryIds.turn];
  turn.assembled.conversationMemoryIds = [...ledger.memoryIds.conversation];
  turn.assembled.projectMemoryIds = [...ledger.memoryIds.project];
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
    const messages = messagesOf(catalog, ledger, turn, deps.dataDir);
    const tools = toolSchemas(catalog, [...turn.assembled.baseToolsIds, ...turn.assembled.toolIds]);
    turn.usage!.modelRequests += 1;
    saveTurn(deps.dataDir, turn);
    appendEvent(deps.dataDir, ledger.conversationId, {
      kind: "provider-request",
      turnId,
      data: { windowChars: ledger.windowChars, toolIds: [...turn.assembled.baseToolsIds, ...turn.assembled.toolIds], usage: { ...turn.usage } },
    });
    const result = await deps.provider.complete({
      messages,
      tools,
      baseToolsIds: turn.assembled.baseToolsIds,
      toolIds: turn.assembled.toolIds,
    });
    if (wasStopped(deps.dataDir, ledger.conversationId, turn.turnId)) return stoppedReply(ledger, turn);
    const toolIds = [...turn.assembled.baseToolsIds, ...turn.assembled.toolIds];
    appendProviderExchange(deps.dataDir, ledger.conversationId, {
      turnId,
      messages,
      content: result.content,
      request: { toolIds },
      response: {
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
          writeFault(ledger, turnId, {
            ...result,
            badName: fault.name,
            detail: fault.detail,
            toolCalls: [{ id: fault.callId, name: fault.name, arguments: { rawArguments: fault.rawArguments } }],
          });
        }
      } else {
        writeFault(ledger, turnId, result);
      }
      const batchCheck = checkToolCalls(result.toolCalls, tools, turn.assembled.baseToolsIds, turn.assembled.toolIds);
      const validCalls = result.toolCalls.filter((call) => {
        if (batchCheck.faultCode === "exclusive_resident") return false;
        const check = checkToolCalls([call], tools, turn.assembled.baseToolsIds, turn.assembled.toolIds);
        if (!check.schemaOk && (result.toolCallFaults?.length || call.name !== result.badName)) {
          writeFault(ledger, turnId, { ...result, ...check, toolCalls: [call] });
        }
        return check.schemaOk;
      });
      if (!result.parseOk && batchCheck.faultCode === "exclusive_resident") {
        writeFault(ledger, turnId, { ...result, ...batchCheck });
      }
      if (validCalls.length) {
        ledger.toolQueue = validCalls.map((call) => ({
          callId: call.id,
          name: call.name,
          arguments: call.arguments,
        }));
        const closed = await runQueue({
          dataDir: deps.dataDir,
          ledger,
          turn,
          catalog,
          content: result.content,
          browserNames: catalog.index.browser,
          host: deps.host,
        });
        if (wasStopped(deps.dataDir, ledger.conversationId, turn.turnId)) return stoppedReply(ledger, turn);
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
        callId: "call_fault",
        name: "finishTurn",
        turnId,
        arguments: {},
        return: clipReturn(catalog.assemble.messages.needFinishTurn),
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
      callId: call.id,
      name: call.name,
      arguments: call.arguments,
    }));
    const closed = await runQueue({
      dataDir: deps.dataDir,
      ledger,
      turn,
      catalog,
      content: result.content,
      browserNames: catalog.index.browser,
      host: deps.host,
    });
    if (wasStopped(deps.dataDir, ledger.conversationId, turn.turnId)) return stoppedReply(ledger, turn);
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
    // Empty legacy finishTurn calls must not create an unbounded retry loop.
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
