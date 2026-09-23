import { saveContextRecord } from "./records.ts";
import { wrapCachedText } from "./cache-lines.ts";
import { deleteMemory, saveMemory, updateMemory } from "../memory/store.ts";
import type { Ledger, MemoryRecord, ToolQueueItem, Turn, TurnOutput } from "../types.ts";
import type { ToolEffect } from "../tools/effects.ts";
import { allocateRecordId, nowIso } from "./ids.ts";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { appendEvent, paths, saveLedger, saveTurn } from "./store.ts";
import { runtimeConfig } from "../config/runtime.ts";

const recordDirectory = (dataDir: string, conversationId: string, kind: string) =>
  join(dataDir, "conversations", conversationId, "context-records", kind);

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
      case "memory.update": {
        const memoryId = effect.memoryId;
        if (!/^(?:mm|lm)_[0-9]{2,}$/.test(memoryId)) throw new Error("memory.update 需要 mm_/lm_ 记忆编号");
        const text = String(effect.text ?? "").trim();
        if (!text) throw new Error("memory.update 需要非空 text");
        const updated = updateMemory(dataDir, ledger.conversationId, memoryId, text);
        appendEvent(dataDir, ledger.conversationId, {
          kind: "memory", turnId: turn.turnId,
          data: { memoryId, layer: updated.layer, sourceCallId: call.callId, action: "update" },
        });
        break;
      }
      case "memory.delete": {
        const memoryId = effect.memoryId;
        if (!/^(?:mm|lm)_[0-9]{2,}$/.test(memoryId)) throw new Error("memory.delete 需要 mm_/lm_ 记忆编号");
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
      case "skill.load": {
        if (!effect.id.trim()) throw new Error("skill.load 需要非空 id");
        ledger.loadedSkillIds = [...new Set([...(ledger.loadedSkillIds ?? []), effect.id])];
        break;
      }
      case "page.set": {
        const id = allocateRecordId(dataDir, ledger.conversationId, "page");
        const resultChars = JSON.stringify(effect.result).length;
        const inlineLimit = runtimeConfig.results.inlineChars;
        const lineWidth = runtimeConfig.results.lineWidth;
        const totalLines = resultChars <= 0 ? 0 : Math.ceil(resultChars / lineWidth);
        const windowResult = resultChars > inlineLimit
          ? (() => {
            const previewSource = typeof effect.result === "string"
              ? effect.result
              : JSON.stringify(effect.result);
            return {
              ok: true,
              externalized: true,
              callId: call.callId,
              type: call.name,
              totalChars: resultChars,
              totalLines,
              lineWidth,
              preview: previewSource.slice(0, runtimeConfig.results.previewChars),
              path: join(paths(dataDir, ledger.conversationId).conv, "context-records", "pageObservation", `${id}.json`),
              message: `runtime: 观察结果超过 ${inlineLimit} 字符，已按 ${lineWidth} 字/行缓存本地（共 ${totalLines} 行）；preview 为原文前 ${runtimeConfig.results.previewChars} 字符。用 evidence.search(windows=[{pageId:"${id}",keyword|startLine}]) 取片段，可一次带多个窗口。`,
              search: "evidence.search",
            };
          })()
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
        // A1: retrieval copy is line-wrapped on disk; structured JSON archive stays intact.
        const searchable = typeof effect.result === "string"
          ? effect.result
          : JSON.stringify(effect.result ?? null);
        const pageDir = recordDirectory(dataDir, ledger.conversationId, "pageObservation");
        mkdirSync(pageDir, { recursive: true });
        writeFileSync(join(pageDir, `${id}.txt`), wrapCachedText(searchable));
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
      case "checklist.set": {
        ledger.checklist = {
          ...(effect.title ? { title: effect.title } : {}),
          items: effect.items.map((item) => ({ text: item.text, status: item.status })),
          updatedAt: nowIso(),
        };
        break;
      }
      case "checklist.update": {
        const current = ledger.checklist ?? { items: [], updatedAt: nowIso() };
        const items = current.items.map((item) => ({ ...item }));
        for (const patch of effect.items) {
          const item = items[patch.index];
          if (!item) continue;
          if (patch.text !== undefined) item.text = patch.text;
          if (patch.status !== undefined) item.status = patch.status;
        }
        ledger.checklist = {
          ...(current.title !== undefined ? { title: current.title } : {}),
          items,
          updatedAt: nowIso(),
        };
        break;
      }
      case "reflect.write": {
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
      case "reflect.delete": {
        const list = turn.reflect ?? [];
        const next = list.filter(item => item.id !== effect.id);
        if (next.length === list.length) throw new Error(`反思 ${effect.id} 不存在`);
        turn.reflect = next;
        break;
      }
      case "tab.context.set": {
        ledger.contextTab = { tabId: effect.tabId, setAt: nowIso() };
        break;
      }
      case "tab.context.clear": {
        ledger.contextTab = null;
        break;
      }
      case "turn.ask":
        turn.status = "waiting_human";
        turn.completedAt = nowIso();
        output = turn.output = { kind: "ask", question: effect.question };
        ledger.status = "waiting_human";
        ledger.pendingAsk = { turnId: turn.turnId, question: effect.question };
        ledger.active = { turnId: turn.turnId };
        ledger.checklist = null;
        break;
      case "turn.reply":
        turn.status = "completed";
        turn.completedAt = nowIso();
        output = turn.output = { kind: "reply", text: effect.text };
        ledger.status = "idle";
        ledger.active = null;
        ledger.pendingAsk = null;
        ledger.toolQueue = [];
        ledger.checklist = null;
        break;
      case "queue.clear": ledger.toolQueue = []; break;
    }
  }
  ledger.liveTools = [];
  saveTurn(dataDir, turn);
  saveLedger(dataDir, ledger);
  return output;
}
