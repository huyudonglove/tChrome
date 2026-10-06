import { saveContextRecord } from "./records.ts";
import { deleteMemory, saveMemory, updateMemory } from "../memory/store.ts";
import type { Ledger, MemoryRecord, RuntimeExecutionContext, ToolQueueItem, Turn, TurnStopReason } from "../types.ts";
import type { ToolEffect } from "../tools/effects.ts";
import { allocateRecordId, nowIso } from "./ids.ts";
import { prepareTaskComplete, prepareTaskSet, prepareTaskUpdate } from "./tasks.ts";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { appendEvent, paths, saveLedger, saveTurn } from "./store.ts";
import { admitReturn } from "../admission.ts";

const recordDirectory = (dataDir: string, conversationId: string, kind: string) =>
  join(dataDir, "conversations", conversationId, "context-records", kind);

/** On turn close, persist non-empty reflect into ledger history (turn-scoped; compresses with the turn). */
export function archiveTurnReflection(ledger: Ledger, turn: Turn): void {
  if (!turn.reflect?.length) return;
  const items = turn.reflect.map(item => ({ ...item }));
  const at = turn.completedAt ?? nowIso();
  const existing = ledger.reflectHistory.find(row => row.turnId === turn.turnId);
  if (existing) {
    existing.items = items;
    existing.at = at;
    return;
  }
  ledger.reflectHistory.push({ turnId: turn.turnId, items, at });
}

export function applyToolEffects(input: {
  dataDir: string;
  ledger: Ledger;
  turn: Turn;
  call: ToolQueueItem;
  effects: ToolEffect[];
  execCtx?: RuntimeExecutionContext;
  storedText?: string;
}): TurnStopReason | null {
  const { dataDir, ledger, turn, call, effects } = input;
  const storedResult = (() => {
    if (!input.storedText) return undefined;
    try {
      const value = JSON.parse(input.storedText) as unknown;
      return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
    } catch {
      return undefined;
    }
  })();
  const execCtx = input.execCtx ?? {
    activeTaskId: ledger.activeTaskId,
    activeTaskItemId: ledger.activeTaskItemId,
  };
  let output: TurnStopReason | null = null;
  for (const effect of effects) {
    switch (effect.type) {
      case "query.set": {
        // 反复查询直接塞进数组，不设 current 位、不做退休。
        ledger.queryHistory.push({ ...effect.query,
          queryId: allocateRecordId(dataDir, ledger.conversationId, "query"),
          turnId: turn.turnId, sourceCallId: call.callId });
        break;
      }
      case "note.write": {
        const prev = ledger.notes[effect.key];
        const id = prev ? prev.id : allocateRecordId(dataDir, ledger.conversationId, "note");
        ledger.notes[effect.key] = { id, value: effect.value };
        break;
      }
      case "note.delete": delete ledger.notes[effect.key]; break;
      case "task_set": {
        prepareTaskSet(dataDir, { ledger, turnId: turn.turnId, sourceCallId: call.callId }, {
          title: effect.title,
          items: effect.items,
        });
        break;
      }
      case "task_update": {
        prepareTaskUpdate(dataDir, { ledger, turnId: turn.turnId, sourceCallId: call.callId }, {
          taskId: effect.taskId,
          items: effect.items,
        });
        break;
      }
      case "task_complete": {
        prepareTaskComplete(dataDir, { ledger, turnId: turn.turnId, sourceCallId: call.callId }, {
          taskId: effect.taskId,
          reason: effect.reason,
        });
        break;
      }
      case "memory.append":
        for (const { layer, text, scope, summary } of effect.entries) {
          const memoryId = allocateRecordId(dataDir, ledger.conversationId, layer === "project" ? "projectMemory" : "conversationMemory");
          const record: MemoryRecord = {
            memoryId, turnId: turn.turnId, layer, text,
            ...(scope ? { scope } : {}),
            ...(summary ? { summary } : {}),
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
      case "memory_update": {
        const memoryId = effect.memoryId;
        if (!/^(?:mm|lm)_[0-9]{2,}$/.test(memoryId)) throw new Error("memory_update 需要 mm_/lm_ 记忆编号");
        const text = String(effect.text ?? "").trim();
        if (!text) throw new Error("memory_update 需要非空 text");
        const updated = updateMemory(dataDir, ledger.conversationId, memoryId, text);
        appendEvent(dataDir, ledger.conversationId, {
          kind: "memory", turnId: turn.turnId,
          data: { memoryId, layer: updated.layer, sourceCallId: call.callId, action: "update" },
        });
        break;
      }
      case "memory_delete": {
        const memoryId = effect.memoryId;
        if (!/^(?:mm|lm)_[0-9]{2,}$/.test(memoryId)) throw new Error("memory_delete 需要 mm_/lm_ 记忆编号");
        const removed = deleteMemory(dataDir, ledger.conversationId, memoryId);
        if (!removed.existed) throw new Error(`记忆 ${memoryId} 不存在`);
        ledger.memoryIds.conversation = ledger.memoryIds.conversation.filter((id) => id !== memoryId);
        ledger.memoryIds.project = ledger.memoryIds.project.filter((id) => id !== memoryId);
        turn.assembled.conversationMemoryIds = turn.assembled.conversationMemoryIds.filter((id) => id !== memoryId);
        turn.assembled.projectMemoryIds = turn.assembled.projectMemoryIds.filter((id) => id !== memoryId);
        appendEvent(dataDir, ledger.conversationId, {
          kind: "memory", turnId: turn.turnId,
          data: { memoryId, layer: removed.layer, sourceCallId: call.callId, action: "delete" },
        });
        break;
      }
      case "tools.enable":
        ledger.loadedToolIds = [...new Set([...ledger.loadedToolIds, ...effect.names])];
        turn.assembled.toolIds = [...new Set([...turn.assembled.toolIds, ...effect.names])];
        break;
      case "tools.disable": {
        const drop = new Set(effect.names);
        ledger.loadedToolIds = ledger.loadedToolIds.filter((id) => !drop.has(id));
        turn.assembled.toolIds = turn.assembled.toolIds.filter((id) => !drop.has(id));
        break;
      }
      case "skill_load": {
        if (!effect.id.trim()) throw new Error("skill_load 需要非空 id");
        ledger.loadedSkillIds = [...new Set([...(ledger.loadedSkillIds ?? []), effect.id])];
        break;
      }
      case "page.set": {
        // Identity only: observations are written explicitly via observation_write.
        if (effect.result.ok) {
          const previous = turn.assembled.currentPage;
          turn.assembled.currentPage = {
            tabId: effect.page.tabId,
            url: effect.page.url || previous?.url || "",
            title: effect.page.title || previous?.title || "",
            description: effect.page.description || previous?.description || "当前页面信息",
          };
        }
        break;
      }
      case "observation_write": {
        // 1-based turn number, same numbering as context/projections/conversation.ts (inputs index + 1):
        // the current turn's input is not in userInputHistory yet, so it sits one past the stored ones.
        const currentTurn = ledger.userInputHistory.length + 1;
        const refreshId = effect.refresh;
        let refreshedIndex = -1;
        if (refreshId !== undefined) {
          refreshedIndex = turn.assembled.observations.findIndex((item) => item.id === refreshId);
          const previous = refreshedIndex >= 0 ? turn.assembled.observations[refreshedIndex] : undefined;
          if (!previous) throw new Error(`observation.refresh: ${refreshId} is not in this turn's observations`);
          if (previous.writtenTurn !== currentTurn) {
            throw new Error(`observation.refresh: ${refreshId} was written in turn ${previous.writtenTurn ?? "unknown"}; only the current turn (${currentTurn}) can be refreshed`);
          }
        }
        const refreshed = refreshedIndex >= 0 ? turn.assembled.observations[refreshedIndex] : undefined;
        const id = refreshed ? refreshed.id : allocateRecordId(dataDir, ledger.conversationId, "page");
        // Observation body is the effect payload; storedText is only the tool ack.
        const result = effect.result ?? storedResult;
        const searchable = typeof result === "string" ? result : JSON.stringify(result);
        const obsDir = recordDirectory(dataDir, ledger.conversationId, "observation");
        mkdirSync(obsDir, { recursive: true });
        if (refreshedIndex >= 0) rmSync(join(obsDir, `${id}.index.json`), { force: true });
        const admitted = admitReturn(searchable, {
          pageId: id,
          path: join(obsDir, `${id}.txt`),
        }, {
          persistIndex: (index) => {
            const path = join(obsDir, `${id}.index.json`);
            writeFileSync(path, JSON.stringify(index));
            return path;
          },
        });
        const windowResult = admitted.mode === "preview" ? admitted.payload : result;
        // 1-based turn number, same numbering as context/projections/conversation.ts (inputs index + 1):
        // the current turn's input is not in userInputHistory yet, so it sits one past the stored ones.
        const writtenTurn = ledger.userInputHistory.length + 1;
        const record = {
          id,
          turnId: turn.turnId,
          observedAt: nowIso(),
          callId: call.callId,
          ...(call.batchId ? { batchId: call.batchId } : {}),
          ...(effect.tabId !== undefined ? { tabId: effect.tabId } : {}),
          type: effect.observationType,
          result,
          ...(execCtx.activeTaskId ? { taskId: execCtx.activeTaskId } : {}),
          ...(execCtx.activeTaskItemId ? { taskItemId: execCtx.activeTaskItemId } : {}),
          writtenTurn,
          ...(effect.validForTurns !== undefined ? { validUntilTurn: writtenTurn + effect.validForTurns - 1 } : {}),
        };
        if (refreshedIndex >= 0) {
          // Refresh rewrites in place: saveContextRecord is immutable by design, so a re-issued
          // record would throw instead of renewing an entry written earlier in this same turn.
          writeFileSync(join(obsDir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
        } else {
          saveContextRecord(dataDir, ledger.conversationId, "observation", record);
        }
        writeFileSync(join(obsDir, `${id}.txt`), searchable);
        if (refreshedIndex >= 0) {
          turn.assembled.observations[refreshedIndex] = { ...record, result: windowResult };
        } else {
          turn.assembled.observations.push({
            ...record,
            result: windowResult,
          });
        }
        break;
      }
      case "page_clear_result": {
        const index = turn.assembled.observations.findIndex((item) => item.id === effect.pageId);
        if (index === -1) throw new Error(`没有观察 ${effect.pageId}`);
        // Window-only: keep identity fields, mark cleared; local context-records stay intact.
        turn.assembled.observations[index] = {
          ...turn.assembled.observations[index]!,
          result: { ok: true, cleared: true },
        };
        break;
      }
      case "tab_context.set": {
        ledger.contextTab = { tabId: effect.tabId, setAt: nowIso() };
        break;
      }
      case "tab_context.clear": {
        ledger.contextTab = null;
        break;
      }
      case "turn.ask": {
        turn.status = "waiting_human";
        turn.completedAt = nowIso();
        output = turn.stopReason = { kind: "ask", question: effect.question };
        ledger.status = "waiting_human";
        ledger.pendingAsk = { turnId: turn.turnId, question: effect.question };
        ledger.active = { turnId: turn.turnId };
        archiveTurnReflection(ledger, turn);
        break;
      }
      case "turn.reply": {
        turn.status = "completed";
        turn.completedAt = nowIso();
        output = turn.stopReason = { kind: "reply", text: effect.text };
        ledger.status = "idle";
        ledger.active = null;
        ledger.pendingAsk = null;
        ledger.toolQueue = [];
        archiveTurnReflection(ledger, turn);
        break;
      }
      case "reflect_write": {
        const list = turn.reflect ?? [];
        const record = { id: effect.id, text: effect.text, ...(effect.focus ? { focus: effect.focus } : {}) };
        if (effect.replace) {
          const index = list.findIndex(item => item.id === effect.id);
          if (index < 0) throw new Error(`反思 ${effect.id} 不存在`);
          list[index] = record;
        } else list.push(record);
        turn.reflect = list;
        break;
      }
      case "reflect_delete": {
        const list = turn.reflect ?? [];
        const next = list.filter(item => item.id !== effect.id);
        if (next.length === list.length) throw new Error(`反思 ${effect.id} 不存在`);
        turn.reflect = next;
        break;
      }
      case "queue.clear": ledger.toolQueue = []; break;
    }
  }
  ledger.liveTools = [];
  saveTurn(dataDir, turn);
  saveLedger(dataDir, ledger);
  return output;
}
