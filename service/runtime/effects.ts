import { saveContextRecord } from "./records.ts";
import { saveMemory } from "../memory/store.ts";
import type { Ledger, MemoryRecord, ToolQueueItem, Turn, TurnOutput } from "../types.ts";
import type { ToolEffect } from "../tools/effects.ts";
import { allocateRecordId, nowIso } from "./ids.ts";
import { join } from "node:path";
import { appendEvent, paths, saveLedger, saveTurn } from "./store.ts";
import { runtimeConfig } from "../config/runtime.ts";

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
      case "goal.upsert": {
        const index = ledger.goals.findIndex(record => record.id === effect.record.id);
        if (index === -1) ledger.goals.push(effect.record);
        else ledger.goals[index] = effect.record;
        ledger.currentGoalId = effect.currentGoalId;
        turn.goalChanges.push(structuredClone(effect.record));
        break;
      }
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
        const id = allocateRecordId(dataDir, ledger.conversationId, "page");
        const resultChars = JSON.stringify(effect.result).length;
        const inlineLimit = runtimeConfig.results.inlineChars;
        const windowResult = resultChars > inlineLimit
          ? {
            ok: true,
            externalized: true,
            callId: call.callId,
            type: call.name,
            totalChars: resultChars,
            path: join(paths(dataDir, ledger.conversationId).conv, "context-records", "pageObservation", `${id}.json`),
            message: `runtime: 观察结果超过 ${inlineLimit} 字符，全文已缓存本地。请用 evidence.search(pageId=${id}, keyword) 检索；本地 path 见本字段。`,
            search: "evidence.search",
          }
          : effect.result;
        const record = {
          id,
          turnId: turn.turnId,
          observedAt: nowIso(),
          callId: call.callId,
          ...(call.batchId ? { batchId: call.batchId } : {}),
          tabId: effect.page.tabId,
          type: call.name,
          // Local archive keeps the full payload; the window may see a pointer only.
          result: effect.result,
        };
        saveContextRecord(dataDir, ledger.conversationId, "pageObservation", record);
        // Failures stay in the observation log but do not replace the current page identity.
        if (effect.result.ok) {
          const previous = turn.assembled.currentPage;
          turn.assembled.currentPage = {
            tabId: effect.page.tabId,
            url: effect.page.url || previous?.url || "",
            title: effect.page.title || previous?.title || "",
            description: effect.page.description || previous?.description || "当前页面信息",
          };
        }
        turn.assembled.pageObservedHistory.push({
          ...record,
          result: windowResult,
        });
        break;
      }
      case "page.clear_result": {
        const index = turn.assembled.pageObservedHistory.findIndex((item) => item.id === effect.pageId);
        if (index === -1) throw new Error(`没有观察 ${effect.pageId}`);
        // Window-only: keep identity fields, mark cleared; local context-records stay intact.
        turn.assembled.pageObservedHistory[index] = {
          ...turn.assembled.pageObservedHistory[index]!,
          result: { ok: true, cleared: true },
        };
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
