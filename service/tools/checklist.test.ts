import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "./execute.ts";
import { applyToolEffects } from "../runtime/effects.ts";
import { emptyLedger } from "../runtime/store.ts";
import { loadToolRegistry, toolSchemas } from "./registry.ts";
import { checkToolCalls } from "./schema.ts";
import type { Turn } from "../types.ts";

const repoRoot = "/Users/huyudong/Projects/tChrome";
const registry = loadToolRegistry(repoRoot);

test("checklist.set and checklist.update are resident and schema-valid", () => {
  expect(registry.toolGroups.baseToolsIds).toContain("checklist.set");
  expect(registry.toolGroups.baseToolsIds).toContain("checklist.update");
  const tools = toolSchemas(registry, ["checklist.set", "checklist.update"]);
  expect(checkToolCalls([
    { id: "c1", name: "checklist.set", arguments: {
      reason: "开始执行", affectsPage: false, title: "上传检查",
      items: [{ text: "打开页" }, { text: "定位控件", status: "doing" }],
    } },
    { id: "c2", name: "checklist.update", arguments: {
      reason: "更新进度", affectsPage: false,
      items: [{ index: 0, status: "done" }],
    } },
  ], tools, registry.toolGroups.baseToolsIds, ["checklist.set", "checklist.update"]).schemaOk).toBe(true);
});

test("checklist tools write ledger and clear when turn ends", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-checklist-"));
  try {
    const ledger = emptyLedger("cv_01");
    ledger.status = "running";
    ledger.active = { turnId: "tn_01" };
    const turn: Turn = {
      turnId: "tn_01", conversationId: "cv_01", status: "inferring",
      createdAt: new Date().toISOString(), completedAt: null,
      input: { id: "input_01", text: "做检查", submittedAt: "now" },
      output: null, goalChanges: [],
      assembled: {
        baseToolsIds: [], toolIds: [],
        conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [],
        currentPage: null, openTabs: { ok: true, windows: [] }, pageObservedHistory: [],
      },
    };
    const exec = async (name: string, args: Record<string, unknown>) => executeTool({
      name,
      arguments: args,
      dataDir,
      lookup: { knownTools: ["checklist.set", "checklist.update", "finishTurn"], enabledTools: ["checklist.set", "checklist.update", "finishTurn"], unusedTools: [] },
    });
    const set = await exec("checklist.set", {
      reason: "开始", affectsPage: false, title: "任务",
      items: [{ text: "步骤一" }, { text: "步骤二", status: "todo" }],
    });
    expect(JSON.parse(set.text)).toMatchObject({ ok: true, count: 2 });
    applyToolEffects({ dataDir, ledger, turn, call: { callId: "c1", name: "checklist.set", arguments: {} }, effects: set.effects });
    expect(ledger.checklist).toMatchObject({
      title: "任务",
      items: [{ text: "步骤一", status: "todo" }, { text: "步骤二", status: "todo" }],
    });
    const upd = await exec("checklist.update", {
      reason: "推进", affectsPage: false,
      items: [{ index: 0, status: "done" }, { index: 1, status: "doing", text: "步骤二改" }],
    });
    applyToolEffects({ dataDir, ledger, turn, call: { callId: "c2", name: "checklist.update", arguments: {} }, effects: upd.effects });
    expect(ledger.checklist?.items).toEqual([
      { text: "步骤一", status: "done" },
      { text: "步骤二改", status: "doing" },
    ]);
    const finish = await exec("finishTurn", { reason: "收口", affectsPage: false, text: "完成" });
    applyToolEffects({ dataDir, ledger, turn, call: { callId: "c3", name: "finishTurn", arguments: {} }, effects: finish.effects });
    expect(ledger.checklist).toBeNull();
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
