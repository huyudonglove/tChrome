import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "./execute.ts";
import { applyToolEffects } from "../runtime/effects.ts";
import { emptyLedger, loadLedger } from "../runtime/store.ts";
import { loadToolRegistry, toolSchemas } from "./registry.ts";
import { checkToolCalls } from "./schema.ts";
import { autoCompleteActiveTask, executionContext, pauseActiveTask } from "../runtime/tasks.ts";
import type { Turn } from "../types.ts";

const repoRoot = new URL("../../", import.meta.url).pathname;
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
    stopReason: null,     assembled: {
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
    browserNames: [],
    lookup: {
      knownTools: ["task_set", "task_update", "task_complete", "finishTurn"],
      enabledTools: ["task_set", "task_update", "task_complete", "finishTurn"],
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
  expect(registry.toolGroups.baseToolsIds).toContain("task_set");
  expect(registry.toolGroups.baseToolsIds).toContain("task_update");
  expect(registry.toolGroups.baseToolsIds).toContain("task_complete");
  expect(registry.toolGroups.baseToolsIds).not.toContain("checklist.set");
  expect(registry.tools["checklist.set"]).toBeUndefined();
  const tools = toolSchemas(registry, ["task_set", "task_update", "task_complete"]);
  expect(checkToolCalls([
    { id: "c1", name: "task_set", arguments: {
      reason: "开始执行", title: "上传检查",
      items: [{ text: "打开页" }, { text: "定位控件", status: "doing" }],
    } },
    { id: "c2", name: "task_update", arguments: {
      reason: "更新进度",
      items: [{ id: "item_01", status: "done" }],
    } },
    { id: "c3", name: "task_complete", arguments: { reason: "收口" } },
  ], tools, registry.toolGroups.baseToolsIds, ["task_set", "task_update", "task_complete"]).schemaOk).toBe(true);
});

test("task persists, single doing, history append-only", async () => {
  const fx = fixture();
  try {
    const standalone = await fx.execute("task_set", { reason: "独立任务", items: [{ text: "步骤一" }] });
    expect(JSON.parse(standalone.text)).toMatchObject({ ok: true, count: 1 });
    fx.apply(standalone, "c_standalone", "task_set");
    expect(fx.ledger.activeTaskId).toBe("task_01");
    expect(fx.ledger.tasks[0]).toMatchObject({
      id: "task_01",
      status: "active",
      createdTurnId: "tn_plan",
      updatedTurnId: "tn_plan",
    });

    const set = await fx.execute("task_set", {
      reason: "拆步骤", title: "修复",
      items: [
        { text: "复现", status: "doing", expectedEffect: "稳定失败", verification: "日志出现" },
        { text: "修复" },
      ],
    });
    expect(JSON.parse(set.text)).toMatchObject({ ok: true, count: 2 });
    const historyAfterSet = fx.ledger.taskHistory.length;
    fx.apply(set, "c1", "task_set");
    // items: standalone used item_01; the replacement task uses item_02, item_03
    expect(fx.ledger.activeTaskId).toBe("task_02");
    expect(fx.ledger.activeTaskItemId).toBe("item_02");
    expect(fx.ledger.tasks.find((t) => t.id === "task_01")).toMatchObject({ status: "cancelled" });
    expect(fx.ledger.tasks[1]).toMatchObject({ id: "task_02", status: "active" });
    expect(fx.ledger.taskHistory.length).toBeGreaterThan(historyAfterSet);
    expect(fx.ledger.taskHistory.at(-1)).toMatchObject({
      type: "item_started",
      taskItemId: "item_02",
      turnId: fx.turn.turnId,
    });

    const historyIds = fx.ledger.taskHistory.map((row) => row.id);
    expect(new Set(historyIds).size).toBe(historyIds.length);

    const doubleDoing = await fx.execute("task_update", {
      reason: "错误双 doing",
      items: [{ id: "item_03", status: "doing" }, { id: "item_02", status: "doing" }],
    });
    expect(doubleDoing.effects.length).toBe(1);
    expect(() => fx.apply(doubleDoing, "c2", "task_update")).toThrow(/最多一个 doing/);

    const step = await fx.execute("task_update", {
      reason: "推进",
      items: [{ id: "item_02", status: "done" }, { id: "item_03", status: "doing", blockedReason: "网络超时" }],
    });
    const parsedStep = JSON.parse(step.text);
    expect(parsedStep.hint).toContain("reflect_write");
    fx.apply(step, "c3", "task_update");
    const active = fx.ledger.tasks[1]!;
    expect(active.items[0]).toMatchObject({ status: "done" });
    expect(active.items[1]).toMatchObject({ status: "doing" });
    expect(fx.ledger.activeTaskItemId).toBe("item_03");

    const ctx = executionContext(fx.ledger);
    expect(ctx).toEqual({ activeTaskId: "task_02", activeTaskItemId: "item_03" });

    const early = await fx.execute("task_complete", { reason: "提前" });
    expect(() => fx.apply(early, "c4", "task_complete")).toThrow(/未完成步骤/);

    const done2 = await fx.execute("task_update", { reason: "完成步骤", items: [{ id: "item_03", status: "done" }] });
    fx.apply(done2, "c5", "task_update");
    const complete = await fx.execute("task_complete", { reason: "步骤齐" });
    fx.apply(complete, "c6", "task_complete");
    expect(fx.ledger.tasks[1]!.status).toBe("completed");
    expect(fx.ledger.activeTaskId).toBeNull();

    fx.ledger.active = { turnId: "tn_plan2" };
    expect(fx.ledger.tasks[1]!.status).toBe("completed");
    expect(fx.ledger.taskHistory.at(-1)).toMatchObject({ type: "task_completed" });

    const set2 = await fx.execute("task_set", { reason: "换任务", items: [{ text: "新步骤" }] });
    fx.apply(set2, "c7", "task_set");
    expect(fx.ledger.tasks[2]).toMatchObject({ id: "task_03", status: "active" });

    const saved = loadLedger(fx.dataDir, fx.ledger.conversationId);
    expect(saved.schemaVersion).toBe(2);
    expect(saved.tasks.length).toBeGreaterThanOrEqual(2);
    expect(saved.taskHistory.length).toBeGreaterThan(0);
    expect(saved).not.toHaveProperty("checklist");
  } finally {
    fx.cleanup();
  }
});

test("task_set replace marks previous task cancelled reason=replaced", async () => {
  const fx = fixture();
  try {
    fx.apply(await fx.execute("task_set", { reason: "一", items: [{ text: "a" }] }), "c1", "task_set");
    fx.apply(await fx.execute("task_set", { reason: "二", items: [{ text: "b" }] }), "c2", "task_set");
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
    fx.apply(await fx.execute("task_set", { reason: "自动收口", items: [{ text: "a" }, { text: "b" }] }), "c1", "task_set");
    expect(fx.ledger.activeTaskId).toBe("task_01");
    // Still open: no auto close, the plan stays active.
    expect(autoCompleteActiveTask(fx.dataDir, fx.ledger, "tn_plan")).toBe(false);
    expect(fx.ledger.tasks[0]!.status).toBe("active");

    fx.apply(await fx.execute("task_update", { reason: "全部完成", items: [
      { id: "item_01", status: "done" },
      { id: "item_02", status: "done" },
    ] }), "c2", "task_update");
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

test("task_update supports atomic batch transition regardless of item order", async () => {
  const fx = fixture();
  try {
    fx.apply(await fx.execute("task_set", {
      reason: "测试流转",
      items: [
        { text: "第一步", status: "doing" },
        { text: "第二步", status: "todo" },
      ],
    }), "c1", "task_set");
    expect(fx.ledger.activeTaskId).toBe("task_01");
    expect(fx.ledger.activeTaskItemId).toBe("item_01");

    // 关键：乱序传入（第二步先置 doing，第一步置 done），批次内原子生效，不应因循环顺序抛出 task_multi_doing_update
    const atomicTransition = await fx.execute("task_update", {
      reason: "原子流转推进",
      items: [
        { id: "item_02", status: "doing" },
        { id: "item_01", status: "done" },
      ],
    });
    expect(atomicTransition.effects.length).toBe(1);
    fx.apply(atomicTransition, "c2", "task_update");

    expect(fx.ledger.activeTaskId).toBe("task_01");
    expect(fx.ledger.activeTaskItemId).toBe("item_02");
    expect(fx.ledger.tasks[0]?.items[0]?.status).toBe("done");
    expect(fx.ledger.tasks[0]?.items[1]?.status).toBe("doing");
  } finally {
    fx.cleanup();
  }
});

test("task_update supports recording outcome on done", async () => {
  const fx = fixture();
  try {
    fx.apply(await fx.execute("task_set", {
      reason: "测试 outcome",
      items: [
        { text: "排查核心问题", status: "doing" },
      ],
    }), "c1", "task_set");

    const update = await fx.execute("task_update", {
      reason: "完成并记录产出成果",
      items: [
        {
          id: "item_01",
          status: "done",
          outcome: "定位到根因并修复，单测通过",
        },
      ],
    });
    expect(update.effects.length).toBe(1);
    fx.apply(update, "c2", "task_update");

    expect(fx.ledger.tasks[0]?.items[0]?.status).toBe("done");
    expect(fx.ledger.tasks[0]?.items[0]?.outcome).toBe("定位到根因并修复，单测通过");
  } finally {
    fx.cleanup();
  }
});



test("unfinished active task pauses at turn close and resumes on update", async () => {
  const fx = fixture();
  try {
    fx.apply(await fx.execute("task_set", {
      reason: "测试轮次暂停",
      items: [{ text: "继续处理", status: "doing" }],
    }), "c1", "task_set");

    expect(pauseActiveTask(fx.dataDir, fx.ledger, "tn_plan")).toBe(true);
    expect(fx.ledger.tasks[0]?.status).toBe("paused");
    expect(fx.ledger.activeTaskId).toBeNull();
    expect(fx.ledger.taskHistory.at(-1)).toMatchObject({
      taskId: "task_01",
      type: "task_paused",
      reason: "turn_closed",
      after: { status: "paused" },
    });

    fx.apply(await fx.execute("task_update", {
      taskId: "task_01",
      reason: "恢复任务",
      items: [{ id: "item_01", status: "doing" }],
    }), "c2", "task_update");
    expect(fx.ledger.tasks[0]?.status).toBe("active");
    expect(fx.ledger.activeTaskId).toBe("task_01");
    expect(fx.ledger.taskHistory.at(-1)).toMatchObject({
      taskId: "task_01",
      type: "task_resumed",
      after: { status: "active" },
    });
  } finally {
    fx.cleanup();
  }
});
