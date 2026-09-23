import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadToolRegistry } from "./registry.ts";
import { executeTool } from "./execute.ts";
import { applyToolEffects } from "../runtime/effects.ts";
import { emptyLedger } from "../runtime/store.ts";
import type { Turn } from "../types.ts";

const repoRoot = join(import.meta.dir, "../..");

const turn = (): Turn => ({
  goalChanges: [],
  turnId: "tn_01",
  conversationId: "cv_01",
  status: "inferring",
  createdAt: "now",
  completedAt: null,
  input: { id: "input_01", text: "任务", submittedAt: "now" },
  assembled: { baseToolsIds: [], toolIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], openTabs: { ok: true, windows: [] }, currentPage: null, pageObservedHistory: [] },
  output: null,
});

test("reflect.write allocates rf_ ids and reflect.delete removes by id", async () => {
  const registry = loadToolRegistry(repoRoot);
  expect(registry.tools["reflect.write"]).toBeTruthy();
  expect(registry.tools["reflect.delete"]).toBeTruthy();
  expect(registry.toolGroups.baseToolsIds).toContain("reflect.write");
  expect(registry.toolGroups.baseToolsIds).toContain("reflect.delete");

  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-reflect-"));
  try {
    const ledger = emptyLedger("cv_reflect");
    const current = turn();
    current.conversationId = ledger.conversationId;
    const call = (callId: string, name: string) => ({
      callId, turnId: current.turnId, name, arguments: {},
      return: { stage: "complete" as const, totalChars: 1, text: "" },
    });

    const first = await executeTool({
      name: "reflect.write",
      arguments: { reason: "收口前反思", text: "先记一次", focus: "证据" },
      dataDir,
      conversationId: ledger.conversationId,
      browserNames: [],
      lookup: { unusedTools: [], knownTools: ["reflect.write"], enabledTools: ["reflect.write"] },
    });
    const firstBody = JSON.parse(first.text) as { ok: boolean; id: string };
    expect(firstBody.ok).toBe(true);
    expect(firstBody.id).toMatch(/^rf_[0-9]{2,}$/);
    applyToolEffects({ dataDir, ledger, turn: current, call: call("call_01", "reflect.write"), effects: first.effects });
    expect(current.reflect).toEqual([{ id: firstBody.id, text: "先记一次", focus: "证据" }]);

    const second = await executeTool({
      name: "reflect.write",
      arguments: { reason: "再记一条", text: "第二条" },
      dataDir,
      conversationId: ledger.conversationId,
      browserNames: [],
      lookup: { unusedTools: [], knownTools: ["reflect.write"], enabledTools: ["reflect.write"] },
    });
    const secondBody = JSON.parse(second.text) as { id: string };
    expect(secondBody.id).not.toBe(firstBody.id);
    applyToolEffects({ dataDir, ledger, turn: current, call: call("call_02", "reflect.write"), effects: second.effects });
    expect(current.reflect).toHaveLength(2);

    const updated = await executeTool({
      name: "reflect.write",
      arguments: { reason: "更新第一条", id: firstBody.id, text: "修订正文" },
      dataDir,
      conversationId: ledger.conversationId,
      browserNames: [],
      lookup: { unusedTools: [], knownTools: ["reflect.write"], enabledTools: ["reflect.write"] },
    });
    applyToolEffects({ dataDir, ledger, turn: current, call: call("call_03", "reflect.write"), effects: updated.effects });
    expect(current.reflect?.find(item => item.id === firstBody.id)).toEqual({ id: firstBody.id, text: "修订正文" });

    const removed = await executeTool({
      name: "reflect.delete",
      arguments: { reason: "删除一条", id: secondBody.id },
      dataDir,
      conversationId: ledger.conversationId,
      browserNames: [],
      lookup: { unusedTools: [], knownTools: ["reflect.delete"], enabledTools: ["reflect.delete"] },
    });
    expect(JSON.parse(removed.text)).toMatchObject({ ok: true, id: secondBody.id, deleted: true });
    applyToolEffects({ dataDir, ledger, turn: current, call: call("call_04", "reflect.delete"), effects: removed.effects });
    expect(current.reflect?.map(item => item.id)).toEqual([firstBody.id]);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
