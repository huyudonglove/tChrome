import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemory, saveMemory } from "./store.ts";
import { applyToolEffects, sweepExpiredMemories } from "../runtime/effects.ts";
import { emptyLedger } from "../runtime/store.ts";
import { executeTool } from "../tools/execute.ts";
import type { Task, Turn } from "../types.ts";

const lookup = (name: string) => ({ unusedTools: [], knownTools: [name], enabledTools: [name] });

const task = (
  items: { id: string; status: "todo" | "doing" | "done" }[],
  status: Task["status"] = "active",
): Task => ({
  id: "task_01", status, createdAt: "now", updatedAt: "now",
  items: items.map((item, index) => ({ ...item, index, text: item.id, createdAt: "now" })),
});

const turn = (conversationId: string): Turn => ({
  conversationId, turnId: "tn_01", status: "inferring", createdAt: "now", completedAt: null,
  input: { id: "input_01", text: "改记忆", submittedAt: "now" },
  assembled: {
    baseToolsIds: [], toolIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [],
    currentTabs: { ok: true, windows: [] }, currentPage: null, observations: [],
  },
  stopReason: null,
});

const memory = (memoryId: string, layer: "conversation" | "project", text: string, expiresWhen?: { taskId: string; itemId?: string; on: "task_complete" | "item_done" | "task_cancelled" }[]) => ({
  memoryId, turnId: "tn_01", layer, text, createdAt: "now", sourceCallId: "call_00",
  ...(expiresWhen ? { expiresWhen } : {}),
});

test("expiresWhen 必须与记忆正文等长，item_done 必须带 itemId", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "memory-expiry-"));
  try {
    const conversationId = "cv_01";
    const mismatch = await executeTool({
      name: "memory_writeConversation",
      arguments: { reason: "长度不等", conversationMemory: ["a", "b"], expiresWhen: [{ taskId: "task_01", on: "task_complete" }] },
      dataDir, conversationId, browserNames: [], lookup: lookup("memory_writeConversation"),
    });
    expect(JSON.parse(mismatch.text)).toMatchObject({ ok: false, faultCode: "invalid_arguments" });
    expect(mismatch.effects).toEqual([]);

    const noItem = await executeTool({
      name: "memory_writeConversation",
      arguments: { reason: "缺 itemId", conversationMemory: ["a"], expiresWhen: [{ taskId: "task_01", on: "item_done" }] },
      dataDir, conversationId, browserNames: [], lookup: lookup("memory_writeConversation"),
    });
    expect(JSON.parse(noItem.text)).toMatchObject({ ok: false, faultCode: "invalid_arguments" });

    const ok = await executeTool({
      name: "memory_writeConversation",
      arguments: { reason: "无条件传 null", conversationMemory: ["a"], expiresWhen: [null] },
      dataDir, conversationId, browserNames: [], lookup: lookup("memory_writeConversation"),
    });
    expect(ok.text).toContain("conversation=1");
    expect(ok.effects).toEqual([{ type: "memory.append", entries: [{ layer: "conversation", text: "a" }] }]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("task_complete 触发过期删除，未设条件的记忆保留，重复触发幂等", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "memory-expiry-"));
  try {
    const conversationId = "cv_01";
    saveMemory(dataDir, conversationId, memory("mm_01", "conversation", "待删", [{ taskId: "task_01", on: "task_complete" }]));
    saveMemory(dataDir, conversationId, memory("mm_02", "conversation", "保留"));
    const ledger = emptyLedger(conversationId);
    ledger.tasks = [task([{ id: "item_01", status: "done" }])];
    ledger.memoryIds.conversation = ["mm_01", "mm_02"];
    const t = turn(conversationId);

    const done = await executeTool({
      name: "task_complete", arguments: { taskId: "task_01" },
      dataDir, conversationId, browserNames: [], lookup: lookup("task_complete"),
    });
    applyToolEffects({ dataDir, ledger, turn: t, call: { callId: "call_01", name: "task_complete", arguments: {} }, effects: done.effects });

    expect(() => loadMemory(dataDir, conversationId, "mm_01")).toThrow();
    expect(loadMemory(dataDir, conversationId, "mm_02").text).toBe("保留");
    expect(ledger.memoryIds.conversation).toEqual(["mm_02"]);

    // 重复触发：记录已不在，扫描返回空且不抛错。
    expect(sweepExpiredMemories(dataDir, ledger, t)).toEqual([]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("item_done 只删除绑定该 item 的记忆", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "memory-expiry-"));
  try {
    const conversationId = "cv_01";
    saveMemory(dataDir, conversationId, memory("mm_01", "conversation", "item_01 的", [{ taskId: "task_01", itemId: "item_01", on: "item_done" }]));
    saveMemory(dataDir, conversationId, memory("mm_02", "conversation", "item_02 的", [{ taskId: "task_01", itemId: "item_02", on: "item_done" }]));
    const ledger = emptyLedger(conversationId);
    ledger.tasks = [task([{ id: "item_01", status: "todo" }, { id: "item_02", status: "todo" }])];
    ledger.memoryIds.conversation = ["mm_01", "mm_02"];
    const t = turn(conversationId);

    const upd = await executeTool({
      name: "task_update", arguments: { taskId: "task_01", items: [{ id: "item_01", status: "done" }] },
      dataDir, conversationId, browserNames: [], lookup: lookup("task_update"),
    });
    applyToolEffects({ dataDir, ledger, turn: t, call: { callId: "call_01", name: "task_update", arguments: {} }, effects: upd.effects });

    expect(() => loadMemory(dataDir, conversationId, "mm_01")).toThrow();
    expect(loadMemory(dataDir, conversationId, "mm_02").text).toBe("item_02 的");
    expect(ledger.memoryIds.conversation).toEqual(["mm_02"]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("project 记忆的过期条件只在写下它的会话内生效", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "memory-expiry-"));
  try {
    saveMemory(dataDir, "cv_01", memory("lm_01", "project", "跨会话保护", [{ taskId: "task_01", on: "task_complete" }]));
    const otherConversation = emptyLedger("cv_02");
    otherConversation.tasks = [task([{ id: "item_01", status: "done" }], "completed")];
    otherConversation.memoryIds.project = ["lm_01"];
    expect(sweepExpiredMemories(dataDir, otherConversation, turn("cv_02"))).toEqual([]);

    const owner = emptyLedger("cv_01");
    owner.tasks = [task([{ id: "item_01", status: "done" }], "completed")];
    owner.memoryIds.project = ["lm_01"];
    expect(sweepExpiredMemories(dataDir, owner, turn("cv_01"))).toEqual(["lm_01"]);
    expect(() => loadMemory(dataDir, "cv_01", "lm_01")).toThrow();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
