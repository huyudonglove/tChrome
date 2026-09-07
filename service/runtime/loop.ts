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
} from "./store.ts";

const stoppedReply = (dataDir: string, ledger: Ledger, turn: Turn): TurnReply => {
  turn.status = "failed";
  turn.completedAt = nowIso();
  turn.output = { kind: "error", faultCode: "stopped" };
  ledger.status = "paused";
  ledger.active = null;
  ledger.liveTool = null;
  ledger.toolQueue = [];
  saveTurn(dataDir, turn);
  saveLedger(dataDir, ledger);
  appendEvent(dataDir, ledger.conversationId, {
    kind: "turn-output",
    turnId: turn.turnId,
    data: { output: turn.output },
  });
  return { conversationId: ledger.conversationId, turnId: turn.turnId, output: turn.output };
};

const wasStopped = (dataDir: string, conversationId: string) =>
  loadLedger(dataDir, conversationId).status === "paused";

const MAX_OUTBOUNDS = 20;
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
  sopIds: [...catalog.assemble.sopIds],
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
    toolUsage: toolUsageFor(catalog, turn.assembled.toolIds),
  });
  return [
    { role: "system", content: system },
    { role: "user", content: userAfter },
  ];
};

const writeFault = (ledger: Ledger, turnId: string, result: CompletionResult) => {
  const calls = result.toolCalls.length
    ? result.toolCalls
    : [{ id: "call_fault", name: "unknown", arguments: { reason: "", affectsPage: false } }];
  for (const call of calls) {
    const text = JSON.stringify({
      ok: false,
      faultCode: result.faultCode,
      missing: result.missing,
      toolName: call.name,
    });
    ledger.toolIO.push({
      callId: call.id,
      name: call.name,
      turnId,
      arguments: call.arguments,
      return: clipReturn(text),
    });
  }
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
    if (wasStopped(dataDir, ledger.conversationId)) {
      ledger.status = "paused";
      ledger.toolQueue = [];
      ledger.liveTool = null;
      turn.status = "failed";
      turn.completedAt = nowIso();
      turn.output = { kind: "error", faultCode: "stopped" };
      return turn.output;
    }
    ledger.liveTool = { name: item.name, callId: item.callId };
    saveLedger(dataDir, ledger);
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
    if (wasStopped(dataDir, ledger.conversationId)) {
      ledger.status = "paused";
      ledger.toolQueue = [];
      ledger.liveTool = null;
      turn.status = "failed";
      turn.completedAt = nowIso();
      turn.output = { kind: "error", faultCode: "stopped" };
      return turn.output;
    }
    if (item.name === "memory.write") {
      persistMemory(dataDir, ledger, { id: item.callId, name: item.name, arguments: item.arguments });
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
  for (let i = 0; i < MAX_OUTBOUNDS; i++) {
    if (wasStopped(deps.dataDir, ledger.conversationId)) return stoppedReply(deps.dataDir, ledger, turn);
    const messages = messagesOf(catalog, ledger, turn, deps.dataDir);
    const tools = toolSchemas(catalog, [...turn.assembled.baseToolsIds, ...turn.assembled.toolIds]);
    appendEvent(deps.dataDir, ledger.conversationId, {
      kind: "provider-request",
      turnId,
      data: { windowChars: ledger.windowChars, toolIds: [...turn.assembled.baseToolsIds, ...turn.assembled.toolIds] },
    });
    const result = await deps.provider.complete({
      messages,
      tools,
      baseToolsIds: turn.assembled.baseToolsIds,
      toolIds: turn.assembled.toolIds,
    });
    if (wasStopped(deps.dataDir, ledger.conversationId)) return stoppedReply(deps.dataDir, ledger, turn);
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
      writeFault(ledger, turnId, result);
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
      writeFault(ledger, turnId, {
        ...result,
        finish: "error",
        faultCode: "missing_required",
        toolCalls: [{ id: "call_fault", name: "finishTurn", arguments: { reason: "", affectsPage: false } }],
      });
      if (submitFails >= MAX_SUBMIT) {
        turn.status = "failed";
        turn.completedAt = nowIso();
        turn.output = { kind: "error", faultCode: "missing_required" };
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
    if (wasStopped(deps.dataDir, ledger.conversationId)) return stoppedReply(deps.dataDir, ledger, turn);
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
  turn.status = "failed";
  turn.completedAt = nowIso();
  turn.output = { kind: "error", faultCode: "max_outbounds" };
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
