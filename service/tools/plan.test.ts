import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "./execute.ts";
import { applyToolEffects } from "../runtime/effects.ts";
import { emptyLedger, loadLedger } from "../runtime/store.ts";
import { loadToolRegistry, toolSchemas } from "./registry.ts";
import { checkToolCalls } from "./schema.ts";
import { executionContext } from "../runtime/plans.ts";
import type { Turn } from "../types.ts";

const repoRoot = "/Users/huyudong/Projects/tChrome";
const registry = loadToolRegistry(repoRoot);

const fixture = () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-plan-"));
  const ledger = emptyLedger("cv_plan");
  ledger.status = "running";
  ledger.active = { turnId: "tn_plan" };
  const turn: Turn = {
    turnId: "tn_plan", conversationId: "cv_plan", status: "inferring",
    createdAt: new Date().toISOString(), completedAt: null,
    input: { id: "input_plan", text: "做计划", submittedAt: "now" },
    output: null, goalChanges: [],
    assembled: {
      baseToolsIds: [], toolIds: [],
      conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [],
      currentPage: null, openTabs: { ok: true, windows: [] }, pageObservedHistory: [],
    },
  };
  const execute = async (name: string, args: Record<string, unknown>) => executeTool({
    name,
    arguments: args,
    dataDir,
    conversationId: ledger.conversationId,
    goalContext: { goals: ledger.goals, currentGoalId: ledger.currentGoalId, turnId: turn.turnId, sourceCallId: "call_plan" },
    lookup: {
      knownTools: ["plan.set", "plan.update", "plan.complete", "submitGoal", "finishTurn"],
      enabledTools: ["plan.set", "plan.update", "plan.complete", "submitGoal", "finishTurn"],
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

test("plan tools are resident and schema-valid", () => {
  expect(registry.toolGroups.baseToolsIds).toContain("plan.set");
  expect(registry.toolGroups.baseToolsIds).toContain("plan.update");
  expect(registry.toolGroups.baseToolsIds).toContain("plan.complete");
  expect(registry.toolGroups.baseToolsIds).not.toContain("checklist.set");
  expect(registry.tools["checklist.set"]).toBeUndefined();
  const tools = toolSchemas(registry, ["plan.set", "plan.update", "plan.complete"]);
  expect(checkToolCalls([
    { id: "c1", name: "plan.set", arguments: {
      reason: "开始执行", title: "上传检查",
      items: [{ text: "打开页" }, { text: "定位控件", status: "doing" }],
    } },
    { id: "c2", name: "plan.update", arguments: {
      reason: "更新进度",
      items: [{ id: "item_01", status: "done" }],
    } },
    { id: "c3", name: "plan.complete", arguments: { reason: "收口" } },
  ], tools, registry.toolGroups.baseToolsIds, ["plan.set", "plan.update", "plan.complete"]).schemaOk).toBe(true);
});

test("plan persists across turn ends, enforces single doing, history append-only, goal gate", async () => {
  const fx = fixture();
  try {
    // no goal → plan.set fails
    const noGoal = await fx.execute("plan.set", { reason: "先建计划", items: [{ text: "步骤一" }] });
    expect(JSON.parse(noGoal.text)).toMatchObject({ ok: false, faultCode: "invalid_arguments" });
    expect(noGoal.effects).toEqual([]);

    const goalExec = await fx.execute("submitGoal", { reason: "立目标", goal: "修这个 bug" });
    fx.apply(goalExec, "c0", "submitGoal");
    expect(fx.ledger.currentGoalId).toBe("goal_01");

    const set = await fx.execute("plan.set", {
      reason: "拆步骤", title: "修复",
      items: [
        { text: "复现", status: "doing", expectedEffect: "稳定失败", verification: "日志出现" },
        { text: "修复" },
      ],
    });
    expect(JSON.parse(set.text)).toMatchObject({ ok: true, count: 2 });
    const historyAfterSet = fx.ledger.planHistory.length;
    fx.apply(set, "c1", "plan.set");
    expect(fx.ledger.activePlanId).toBe("plan_01");
    expect(fx.ledger.activePlanItemId).toBe("item_01");
    expect(fx.ledger.plans[0]).toMatchObject({ id: "plan_01", goalId: "goal_01", status: "active" });
    expect(fx.ledger.goals[0]).toMatchObject({ planId: "plan_01", activePlanItemId: "item_01" });
    expect(fx.ledger.planHistory.length).toBeGreaterThan(historyAfterSet);
    expect(fx.ledger.planHistory.at(-1)).toMatchObject({
      type: "item_started",
      planItemId: "item_01",
      turnId: fx.turn.turnId,
    });

    // history is append-only snapshot count
    const historyIds = fx.ledger.planHistory.map(row => row.id);
    expect(new Set(historyIds).size).toBe(historyIds.length);

    // two doing rejected
    const doubleDoing = await fx.execute("plan.update", {
      reason: "错误双 doing",
      items: [{ id: "item_02", status: "doing" }, { id: "item_01", status: "doing" }],
    });
    // effects throw on apply because both end doing after sequential patches...
    // first patch sets item_02 doing while item_01 is doing → throw
    expect(doubleDoing.effects.length).toBe(1);
    expect(() => fx.apply(doubleDoing, "c2", "plan.update")).toThrow(/最多一个 doing/);

    // mark first done, start second
    const step = await fx.execute("plan.update", {
      reason: "推进",
      items: [{ id: "item_01", status: "done" }, { id: "item_02", status: "doing" }],
    });
    fx.apply(step, "c3", "plan.update");
    const plan = fx.ledger.plans[0]!;
    expect(plan.items[0]).toMatchObject({ status: "done" });
    expect(plan.items[1]).toMatchObject({ status: "doing" });
    expect(fx.ledger.activePlanItemId).toBe("item_02");

    // toolIO linkage snapshot fields
    const ctx = executionContext(fx.ledger);
    expect(ctx).toEqual({ goalId: "goal_01", activePlanId: "plan_01", activePlanItemId: "item_02" });

    // cannot complete with unfinished items
    const early = await fx.execute("plan.complete", { reason: "提前" });
    expect(() => fx.apply(early, "c4", "plan.complete")).toThrow(/未完成步骤/);

    const done2 = await fx.execute("plan.update", { reason: "完成步骤", items: [{ id: "item_02", status: "done" }] });
    fx.apply(done2, "c5", "plan.update");
    const complete = await fx.execute("plan.complete", { reason: "步骤齐" });
    fx.apply(complete, "c6", "plan.complete");
    expect(fx.ledger.plans[0]!.status).toBe("completed");
    expect(fx.ledger.activePlanId).toBeNull();
    // Plan complete ≠ Goal complete
    expect(fx.ledger.goals[0]!.status).toBe("active");

    // plan survives new turn start (no checklist-style clear)
    fx.ledger.active = { turnId: "tn_plan2" };
    expect(fx.ledger.plans[0]!.status).toBe("completed");
    expect(fx.ledger.planHistory.at(-1)).toMatchObject({ type: "plan_completed" });

    // replace semantics: new active plan on same goal
    const set2 = await fx.execute("plan.set", { reason: "换计划", items: [{ text: "新步骤" }] });
    fx.apply(set2, "c7", "plan.set");
    expect(fx.ledger.plans[1]).toMatchObject({ id: "plan_02", status: "active" });

    // goal end cancels open plan and appends history
    const end = await fx.execute("submitGoal", { reason: "收口", id: "goal_01", status: "completed" });
    fx.apply(end, "c8", "submitGoal");
    expect(fx.ledger.plans[1]!.status).toBe("cancelled");
    expect(fx.ledger.activePlanId).toBeNull();
    expect(fx.ledger.planHistory.some(row => row.type === "plan_cancelled" && row.reason === "goal_ended")).toBe(true);
    expect(fx.ledger.planHistory.some(row => row.type === "goal_completed")).toBe(true);

    // loadLedger v2 keeps plans
    const saved = loadLedger(fx.dataDir, fx.ledger.conversationId);
    expect(saved.schemaVersion).toBe(2);
    expect(saved.plans).toHaveLength(2);
    expect(saved.planHistory.length).toBeGreaterThan(0);
    expect(saved).not.toHaveProperty("checklist");
  } finally {
    fx.cleanup();
  }
});

test("plan.set replace marks previous plan cancelled reason=replaced", async () => {
  const fx = fixture();
  try {
    fx.apply(await fx.execute("submitGoal", { reason: "目标", goal: "任务" }), "c0", "submitGoal");
    fx.apply(await fx.execute("plan.set", { reason: "一", items: [{ text: "a" }] }), "c1", "plan.set");
    fx.apply(await fx.execute("plan.set", { reason: "二", items: [{ text: "b" }] }), "c2", "plan.set");
    expect(fx.ledger.plans[0]).toMatchObject({ status: "cancelled" });
    expect(fx.ledger.planHistory.some(row => row.type === "plan_cancelled" && row.reason === "replaced")).toBe(true);
    expect(fx.ledger.activePlanId).toBe("plan_02");
  } finally {
    fx.cleanup();
  }
});
