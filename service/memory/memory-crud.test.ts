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
  conversationId: cv, turnId: "tn_01", status: "inferring",
  createdAt: "now", completedAt: null,
  input: { id: "input_01", text: "改记忆", submittedAt: "now" },
  assembled: { baseToolsIds: [], toolIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], currentTabs: { ok: true, windows: [] }, currentPage: null, observations: [] },
  stopReason: null,
});

test("memory_update and memory_delete operate by mm_/lm_ id", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "memory-crud-"));
  try {
    const conversationId = "cv_01";
    saveMemory(dataDir, conversationId, { memoryId: "mm_01", turnId: "tn_01", layer: "conversation", text: "旧会话记忆", createdAt: "now", sourceCallId: "call_00" });
    saveMemory(dataDir, conversationId, { memoryId: "lm_01", turnId: "tn_01", layer: "project", text: "旧长久记忆", createdAt: "now", sourceCallId: "call_00" });

    const upd = await executeTool({
      name: "memory_update",
      arguments: { reason: "修正", memoryId: "mm_01", text: "新会话记忆" },
      dataDir, conversationId,
      browserNames: [],
      lookup: { unusedTools: [], knownTools: ["memory_update"], enabledTools: ["memory_update"] },
    });
    expect(JSON.parse(upd.text)).toMatchObject({ ok: true, memoryId: "mm_01", layer: "conversation" });

    const ledger = emptyLedger(conversationId);
    ledger.memoryIds.conversation = ["mm_01"];
    ledger.memoryIds.project = ["lm_01"];
    const t = turn(conversationId);
    applyToolEffects({ dataDir, ledger, turn: t, call: { callId: "call_01", name: "memory_update", arguments: {} }, effects: upd.effects });
    const updatedRecord = loadMemory(dataDir, conversationId, "mm_01");
    expect(updatedRecord.text).toBe("新会话记忆");
    expect(updatedRecord.sourceCallId).toBe("call_01");
    expect(updatedRecord.sourceCallId).not.toBe("call_00");

    const del = await executeTool({
      name: "memory_delete",
      arguments: { reason: "删除", memoryId: "lm_01" },
      dataDir, conversationId,
      browserNames: [],
      lookup: { unusedTools: [], knownTools: ["memory_delete"], enabledTools: ["memory_delete"] },
    });
    applyToolEffects({ dataDir, ledger, turn: t, call: { callId: "call_02", name: "memory_delete", arguments: {} }, effects: del.effects });
    expect(() => loadMemory(dataDir, conversationId, "lm_01")).toThrow();
    expect(ledger.memoryIds.conversation).toEqual(["mm_01"]);
    const reText = updateMemory(dataDir, conversationId, "mm_01", { text: "再改" }, { turnId: "tn_02", sourceCallId: "call_03" });
    expect(reText.sourceCallId).toBe("call_03");
    expect(reText.text).toBe("再改");
    expect(deleteMemory(dataDir, conversationId, "mm_01")).toMatchObject({ layer: "conversation", existed: true });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("memory_update rewrites only the provided fields", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "memory-patch-"));
  try {
    const conversationId = "cv_01";
    saveMemory(dataDir, conversationId, { memoryId: "lm_07", turnId: "tn_01", layer: "project", scope: "tChrome", summary: "旧摘要", text: "旧正文", createdAt: "now", sourceCallId: "call_00" });
    const lookup = { unusedTools: [], knownTools: ["memory_update"], enabledTools: ["memory_update"] };

    const summaryOnly = await executeTool({
      name: "memory_update",
      arguments: { reason: "改摘要", memoryId: "lm_07", summary: "新摘要" },
      dataDir, conversationId, browserNames: [], lookup,
    });
    expect(JSON.parse(summaryOnly.text)).toMatchObject({ ok: true, memoryId: "lm_07", layer: "project", summary: "新摘要" });
    applyToolEffects({ dataDir, ledger: emptyLedger(conversationId), turn: turn(conversationId), call: { callId: "call_01", name: "memory_update", arguments: {} }, effects: summaryOnly.effects });
    const afterSummary = loadMemory(dataDir, conversationId, "lm_07");
    expect(afterSummary.summary).toBe("新摘要");
    expect(afterSummary.text).toBe("旧正文");
    expect(afterSummary.scope).toBe("tChrome");

    const scopeOnly = await executeTool({
      name: "memory_update",
      arguments: { reason: "换归属", memoryId: "lm_07", scope: "other" },
      dataDir, conversationId, browserNames: [], lookup,
    });
    applyToolEffects({ dataDir, ledger: emptyLedger(conversationId), turn: turn(conversationId), call: { callId: "call_02", name: "memory_update", arguments: {} }, effects: scopeOnly.effects });
    const afterScope = loadMemory(dataDir, conversationId, "lm_07");
    expect(afterScope.scope).toBe("other");
    expect(afterScope.summary).toBe("新摘要");
    expect(afterScope.text).toBe("旧正文");

    expect(() => applyToolEffects({ dataDir, ledger: emptyLedger(conversationId), turn: turn(conversationId), call: { callId: "call_03", name: "memory_update", arguments: {} }, effects: [{ type: "memory_update", memoryId: "lm_07" }] })).toThrow();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
