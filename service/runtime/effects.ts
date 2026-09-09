import type { Ledger, MemoryRecord, ToolQueueItem, Turn, TurnOutput } from "../types.ts";
import type { ToolEffect } from "../tools/effects.ts";
import { nextId, nowIso } from "./ids.ts";
import { appendEvent, saveLedger, saveMemory, saveTurn } from "./store.ts";

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
      case "goal.set":
        if (effect.goal !== ledger.goal) {
          if (ledger.goal) ledger.goalHistory.push(ledger.goal);
          ledger.goal = effect.goal;
        }
        break;
      case "note.write": ledger.notes[effect.key] = effect.value; break;
      case "note.delete": delete ledger.notes[effect.key]; break;
      case "memory.append":
        for (const { layer, text } of effect.entries) {
          const memoryId = nextId("mm_", Object.values(ledger.memoryIds).flat());
          const record: MemoryRecord = {
            memoryId, layer, text, summary: text.slice(0, 40), compressed: false,
            createdAt: nowIso(), sourceCallId: call.callId,
          };
          saveMemory(dataDir, ledger.conversationId, record);
          ledger.memoryIds[layer].push(memoryId);
          appendEvent(dataDir, ledger.conversationId, {
            kind: "memory", data: { memoryId, layer, sourceCallId: call.callId },
          });
        }
        break;
      case "context-summary.set": ledger.contextSummary = effect.summary; break;
      case "tools.enable":
        turn.assembled.toolIds = [...new Set([...turn.assembled.toolIds, ...effect.names])];
        break;
      case "page.set": turn.assembled.currentPage = effect.page; break;
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
