import { saveContextRecord } from "./records.ts";
import { saveMemory } from "../memory/store.ts";
import type { Ledger, MemoryRecord, ToolQueueItem, Turn, TurnOutput } from "../types.ts";
import type { ToolEffect } from "../tools/effects.ts";
import { allocateRecordId, nowIso } from "./ids.ts";
import { appendEvent, saveLedger, saveTurn } from "./store.ts";

export function applyToolEffects(input: {
  dataDir: string;
  ledger: Ledger;
  turn: Turn;
  call: ToolQueueItem;
  effects: ToolEffect[];
}): TurnOutput | null {
  const { dataDir, ledger, turn, call, effects } = input;
  let output: TurnOutput | null = null;
  for (const effect of effects) {
    switch (effect.type) {
      case "query.set": {
        if (ledger.currentQuery) ledger.queryHistory.push(ledger.currentQuery);
        ledger.currentQuery = { ...effect.query,
          queryId: allocateRecordId(dataDir, ledger.conversationId, "query"),
          turnId: turn.turnId, sourceCallId: call.callId };
        break;
      }
      case "goal.set":
        if (effect.goal !== ledger.goal?.goal) {
          const record = { id: allocateRecordId(dataDir, ledger.conversationId, "goal"), turnId: turn.turnId, goal: effect.goal, sourceCallId: call.callId, createdAt: nowIso() };
          saveContextRecord(dataDir, ledger.conversationId, "goal", record);
          if (ledger.goal) ledger.goalHistory.push(ledger.goal);
          ledger.goal = record;
        }
        break;
      case "note.write": ledger.notes[effect.key] = effect.value; break;
      case "note.delete": delete ledger.notes[effect.key]; break;
      case "memory.append":
        for (const { layer, text } of effect.entries) {
          const memoryId = allocateRecordId(dataDir, ledger.conversationId, layer === "project" ? "projectMemory" : "conversationMemory");
          const record: MemoryRecord = {
            memoryId, turnId: turn.turnId, layer, text,
            createdAt: nowIso(), sourceCallId: call.callId,
          };
          saveMemory(dataDir, ledger.conversationId, record);
          if (layer === "project") turn.assembled.projectMemoryIds.push(memoryId);
          else ledger.memoryIds[layer].push(memoryId);
          appendEvent(dataDir, ledger.conversationId, {
            kind: "memory", turnId: turn.turnId, data: { memoryId, layer, sourceCallId: call.callId },
          });
        }
        break;
      case "tools.enable":
        ledger.loadedToolIds = [...new Set([...ledger.loadedToolIds, ...effect.names])];
        turn.assembled.toolIds = [...new Set([...turn.assembled.toolIds, ...effect.names])];
        break;
      case "page.set": {
        const record = { ...effect.page, id: allocateRecordId(dataDir, ledger.conversationId, "page"), turnId: turn.turnId, observedAt: nowIso(), callId: call.callId, toolName: call.name };
        saveContextRecord(dataDir, ledger.conversationId, "pageObservation", record);
        turn.assembled.currentPage = record;
        turn.assembled.pageObservedHistory.push(record);
        break;
      }
      case "turn.ask":
        turn.status = "waiting_human";
        turn.completedAt = nowIso();
        output = turn.output = { kind: "ask", question: effect.question };
        ledger.status = "waiting_human";
        ledger.pendingAsk = { turnId: turn.turnId, question: effect.question };
        ledger.active = { turnId: turn.turnId };
        break;
      case "turn.reply":
        turn.status = "completed";
        turn.completedAt = nowIso();
        output = turn.output = { kind: "reply", text: effect.text };
        ledger.status = "idle";
        ledger.active = null;
        ledger.pendingAsk = null;
        ledger.toolQueue = [];
        break;
      case "queue.clear": ledger.toolQueue = []; break;
    }
  }
  ledger.liveTool = null;
  saveTurn(dataDir, turn);
  saveLedger(dataDir, ledger);
  return output;
}
