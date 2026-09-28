import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "./execute.ts";
import { applyToolEffects } from "../runtime/effects.ts";
import { emptyLedger, loadLedger } from "../runtime/store.ts";
import { loadToolRegistry, toolSchemas } from "./registry.ts";
import { checkToolCalls } from "./schema.ts";
import { autoCompleteActiveTask, executionContext } from "../runtime/tasks.ts";
import type { Turn } from "../types.ts";

const repoRoot = "/Users/huyudong/Projects/tChrome";
const registry = loadToolRegistry(repoRoot);

const fixture = () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-task-"));
  const ledger = emptyLedger("cv_plan");
  ledger.status = "running";
  ledger.active = { turnId: "tn_plan" };
  const turn: Turn = {
    turnId: "tn_plan", conversationId: "cv_plan", status: "inferring",
    createdAt: new Date().toISOString(), completedAt: null,
    input: { id: "input_plan", text: "做任务", submittedAt: "now" },
    stopReason: null, goalChanges: [],
    assembled: {
      baseToolsIds: [], toolIds: [],
      conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [],
      currentPage: null, currentTabs: { ok: true, windows: [] }, observations: [],
    },
  };
  const execute = async (name: string, args: Record<string, unknown>) => executeTool({
    name,
    arguments: args,
    dataDir,
    conversationId: ledger.conversationId,
    goalContext: { goals: ledger.goals, currentGoalId: ledger.currentGoalId, turnId: turn.turnId, sourceCallId: "call_plan" },
    lookup: {
      knownTools: ["task.set", "task.update", "task.complete", "submitGoal", "finishTurn"],
      enabledTools: ["task.set", "task.update", "task.complete", "submitGoal", "finishTurn"],
      unusedTools: [],
    },
  });
  const apply = (execution: Awaited<ReturnType<typeof executeTool>>, callId: string, name: string) =>
    applyToolEffects({
      dataDir, ledger, turn,
      call: { callId, name, arguments: {} },
      effects: execution.effects,
      execCtx: executionContext(ledger),
    });
  return { dataDir, ledger, turn, execute, apply, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
};

test("task tools are resident and schema-valid", () => {
  expect(registry.toolGroups.baseToolsIds).toContain("task.set");
  expect(registry.toolGroups.baseToolsIds).toContain("task.update");
  expect(registry.toolGroups.baseToolsIds).toContain("task.complete");
  expect(registry.toolGroups.baseToolsIds).not.toContain("checklist.set");
  expect(registry.tools["checklist.set"]).toBeUndefined();
  const tools = toolSchemas(registry, ["task.set", "task.update", "task.complete"]);
  expect(checkToolCalls([
    { id: "c1", name: "task.set", arguments: {
      reason: "开始执行", title: "上传检查",
      items: [{ text: "打开页" }, { text: "定位控件", status: "doing" }],
    } },
    { id: "c2", name: "task.update", arguments: {
      reason: "更新进度",
      items: [{ id: "item_01", status: "done" }],
    } },
    { id: "c3", name: "task.complete", arguments: { reason: "收口" } },
  ], tools, registry.toolGroups.baseToolsIds, ["task.set", "task.update", "task.complete"]).schemaOk).toBe(true);
});

test("task persists, single doing, history append-only, weak goal link", async () => {
  const fx = fixture();
  try {
    const standalone = await fx.execute("task.set", { reason: "独立任务", items: [{ text: "步骤一" }] });
    expect(JSON.parse(standalone.text)).toMatchObject({ ok: true, count: 1 });
    fx.apply(standalone, "c_standalone", "task.set");
    expect(fx.ledger.activeTaskId).toBe("task_01");
    expect(fx.ledger.tasks[0]).toMatchObject({ id: "task_01", goalId: null, status: "active" });
    expect(fx.ledger.currentGoalId).toBeNull();

    const goalExec = await fx.execute("submitGoal", { reason: "立目标", goal: "修这个 bug" });
    fx.apply(goalExec, "c0", "submitGoal");
    expect(fx.ledger.currentGoalId).toBe("goal_01");

    const set = await fx.execute("task.set", {
      reason: "拆步骤", title: "修复",
      items: [
        { text: "复现", status: "doing", expectedEffect: "稳定失败", verification: "日志出现" },
        { text: "修复" },
      ],
    });
    expect(JSON.parse(set.text)).toMatchObject({ ok: true, count: 2 });
    const historyAfterSet = fx.ledger.taskHistory.length;
    fx.apply(set, "c1", "task.set");
    // items: standalone used item_01; goal task uses item_02, item_03
    expect(fx.ledger.activeTaskId).toBe("task_02");
    expect(fx.ledger.activeTaskItemId).toBe("item_02");
    expect(fx.ledger.tasks.find((t) => t.id === "task_01")).toMatchObject({ status: "cancelled" });
    expect(fx.ledger.tasks[1]).toMatchObject({ id: "task_02", goalId: "goal_01", status: "active" });
    expect(fx.ledger.goals[0]).toMatchObject({ taskId: "task_02" });
    expect(fx.ledger.taskHistory.length).toBeGreaterThan(historyAfterSet);
    expect(fx.ledger.taskHistory.at(-1)).toMatchObject({
      type: "item_started",
      taskItemId: "item_02",
      turnId: fx.turn.turnId,
    });

    const historyIds = fx.ledger.taskHistory.map((row) => row.id);
    expect(new Set(historyIds).size).toBe(historyIds.length);

    const doubleDoing = await fx.execute("task.update", {
      reason: "错误双 doing",
      items: [{ id: "item_03", status: "doing" }, { id: "item_02", status: "doing" }],
    });
    expect(doubleDoing.effects.length).toBe(1);
    expect(() => fx.apply(doubleDoing, "c2", "task.update")).toThrow(/最多一个 doing/);

    const step = await fx.execute("task.update", {
      reason: "推进",
      items: [{ id: "item_02", status: "done" }, { id: "item_03", status: "doing" }],
    });
    fx.apply(step, "c3", "task.update");
    const active = fx.ledger.tasks[1]!;
    expect(active.items[0]).toMatchObject({ status: "done" });
    expect(active.items[1]).toMatchObject({ status: "doing" });
    expect(fx.ledger.activeTaskItemId).toBe("item_03");

    const ctx = executionContext(fx.ledger);
    expect(ctx).toEqual({ goalId: "goal_01", activeTaskId: "task_02", activeTaskItemId: "item_03" });

    const early = await fx.execute("task.complete", { reason: "提前" });
    expect(() => fx.apply(early, "c4", "task.complete")).toThrow(/未完成步骤/);

    const done2 = await fx.execute("task.update", { reason: "完成步骤", items: [{ id: "item_03", status: "done" }] });
    fx.apply(done2, "c5", "task.update");
    const complete = await fx.execute("task.complete", { reason: "步骤齐" });
    fx.apply(complete, "c6", "task.complete");
    expect(fx.ledger.tasks[1]!.status).toBe("completed");
    expect(fx.ledger.activeTaskId).toBeNull();
    expect(fx.ledger.goals[0]!.status).toBe("active");

    fx.ledger.active = { turnId: "tn_plan2" };
    expect(fx.ledger.tasks[1]!.status).toBe("completed");
    expect(fx.ledger.taskHistory.at(-1)).toMatchObject({ type: "task_completed" });

    const set2 = await fx.execute("task.set", { reason: "换任务", items: [{ text: "新步骤" }] });
    fx.apply(set2, "c7", "task.set");
    expect(fx.ledger.tasks[2]).toMatchObject({ id: "task_03", status: "active" });

    const end = await fx.execute("submitGoal", { reason: "收口", id: "goal_01", status: "completed" });
    fx.apply(end, "c8", "submitGoal");
    expect(fx.ledger.tasks[2]!.status).toBe("cancelled");
    expect(fx.ledger.activeTaskId).toBeNull();
    expect(fx.ledger.taskHistory.some((row) => row.type === "task_cancelled" && row.reason === "goal_ended")).toBe(true);
    expect(fx.ledger.taskHistory.some((row) => row.type === "goal_completed")).toBe(true);

    const saved = loadLedger(fx.dataDir, fx.ledger.conversationId);
    expect(saved.schemaVersion).toBe(2);
    expect(saved.tasks.length).toBeGreaterThanOrEqual(2);
    expect(saved.taskHistory.length).toBeGreaterThan(0);
    expect(saved).not.toHaveProperty("checklist");
  } finally {
    fx.cleanup();
  }
});

test("task.set replace marks previous task cancelled reason=replaced", async () => {
  const fx = fixture();
  try {
    fx.apply(await fx.execute("submitGoal", { reason: "目标", goal: "任务" }), "c0", "submitGoal");
    fx.apply(await fx.execute("task.set", { reason: "一", items: [{ text: "a" }] }), "c1", "task.set");
    fx.apply(await fx.execute("task.set", { reason: "二", items: [{ text: "b" }] }), "c2", "task.set");
    expect(fx.ledger.tasks[0]).toMatchObject({ status: "cancelled" });
    expect(fx.ledger.taskHistory.some((row) => row.type === "task_cancelled" && row.reason === "replaced")).toBe(true);
    expect(fx.ledger.activeTaskId).toBe("task_02");
  } finally {
    fx.cleanup();
  }
});

test("autoCompleteActiveTask closes a finished plan and skips open ones", async () => {
  const fx = fixture();
  try {
    fx.apply(await fx.execute("task.set", { reason: "自动收口", items: [{ text: "a" }, { text: "b" }] }), "c1", "task.set");
    expect(fx.ledger.activeTaskId).toBe("task_01");
    // Still open: no auto close, the plan stays active.
    expect(autoCompleteActiveTask(fx.dataDir, fx.ledger, "tn_plan")).toBe(false);
    expect(fx.ledger.tasks[0]!.status).toBe("active");

    fx.apply(await fx.execute("task.update", { reason: "全部完成", items: [
      { id: "item_01", status: "done" },
      { id: "item_02", status: "done" },
    ] }), "c2", "task.update");
    expect(autoCompleteActiveTask(fx.dataDir, fx.ledger, "tn_plan")).toBe(true);
    expect(fx.ledger.tasks[0]!.status).toBe("completed");
    expect(fx.ledger.tasks[0]!.completedAt).toBeTruthy();
    expect(fx.ledger.activeTaskId).toBeNull();
    expect(fx.ledger.activeTaskItemId).toBeNull();
    expect(fx.ledger.taskHistory.at(-1)).toMatchObject({
      taskId: "task_01",
      type: "task_completed",
      reason: "auto_closed",
      after: { status: "completed" },
    });
    // Idempotent: nothing left to close.
    expect(autoCompleteActiveTask(fx.dataDir, fx.ledger, "tn_plan")).toBe(false);
  } finally {
    fx.cleanup();
  }
});
