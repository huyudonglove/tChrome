import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteMemory, loadMemory, saveMemory, updateMemory } from "./store.ts";
import { emptyLedger, saveLedger } from "../runtime/store.ts";
import { applyToolEffects } from "../runtime/effects.ts";
import { executeTool } from "../tools/execute.ts";
import type { Turn } from "../types.ts";

const turn = (cv: string): Turn => ({
  goalChanges: [], conversationId: cv, turnId: "tn_01", status: "inferring",
  createdAt: "now", completedAt: null,
  input: { id: "input_01", text: "改记忆", submittedAt: "now" },
  assembled: { baseToolsIds: [], toolIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], openTabs: { ok: true, windows: [] }, currentPage: null, pageObservedHistory: [] },
  output: null,
});

test("memory.update and memory.delete operate by mm_/lm_ id", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "memory-crud-"));
  try {
    const conversationId = "cv_01";
    saveMemory(dataDir, conversationId, { memoryId: "mm_01", turnId: "tn_01", layer: "conversation", text: "旧会话记忆", createdAt: "now" });
    saveMemory(dataDir, conversationId, { memoryId: "lm_01", turnId: "tn_01", layer: "project", text: "旧长久记忆", createdAt: "now" });

    const upd = await executeTool({
      name: "memory.update",
      arguments: { reason: "修正", affectsPage: false, memoryId: "mm_01", text: "新会话记忆" },
      dataDir, conversationId,
      browserNames: [],
      lookup: { unusedTools: [], knownTools: ["memory.update"], enabledTools: ["memory.update"] },
    });
    expect(JSON.parse(upd.text)).toMatchObject({ ok: true, memoryId: "mm_01", layer: "conversation" });

    const ledger = emptyLedger(conversationId);
    ledger.memoryIds.conversation = ["mm_01"];
    ledger.memoryIds.project = ["lm_01"];
    const t = turn(conversationId);
    applyToolEffects({ dataDir, ledger, turn: t, call: { callId: "call_01", turnId: t.turnId, name: "memory.update", arguments: {} }, effects: upd.effects });
    expect(loadMemory(dataDir, conversationId, "mm_01").text).toBe("新会话记忆");

    const del = await executeTool({
      name: "memory.delete",
      arguments: { reason: "删除", affectsPage: false, memoryId: "lm_01" },
      dataDir, conversationId,
      browserNames: [],
      lookup: { unusedTools: [], knownTools: ["memory.delete"], enabledTools: ["memory.delete"] },
    });
    applyToolEffects({ dataDir, ledger, turn: t, call: { callId: "call_02", turnId: t.turnId, name: "memory.delete", arguments: {} }, effects: del.effects });
    expect(() => loadMemory(dataDir, conversationId, "lm_01")).toThrow();
    expect(ledger.memoryIds.conversation).toEqual(["mm_01"]);
    expect(updateMemory(dataDir, conversationId, "mm_01", "再改").text).toBe("再改");
    expect(deleteMemory(dataDir, conversationId, "mm_01")).toMatchObject({ layer: "conversation", existed: true });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
