import type { GoalRecord, Ledger, Task, TaskHistoryRecord, TaskItem, TaskItemStatus, ToolArguments } from "../types.ts";
import { allocateRecordId, nowIso } from "./ids.ts";
import { errorDetail } from "../../shared/error-details.ts";

export type TaskContext = {
  ledger: Ledger;
  turnId: string;
  sourceCallId: string;
};

const historyId = (dataDir: string, conversationId: string) =>
  allocateRecordId(dataDir, conversationId, "taskHistory");

const taskItemId = (dataDir: string, conversationId: string) =>
  allocateRecordId(dataDir, conversationId, "taskItem");

const pushHistory = (
  dataDir: string,
  ledger: Ledger,
  row: Omit<TaskHistoryRecord, "id" | "at"> & { at?: string; turnId?: string },
  turnId: string,
): void => {
  ledger.taskHistory.push({
    id: historyId(dataDir, ledger.conversationId),
    at: row.at ?? nowIso(),
    turnId,
    ...row,
  });
};

const activeDoing = (plan: Task): TaskItem | null =>
  plan.items.find((item) => item.status === "doing") ?? null;

const syncGoalPlanPointers = (ledger: Ledger, goalId: string | null, plan: Task | null): void => {
  if (!goalId) return;
  const goal = ledger.goals.find((row) => row.id === goalId);
  if (!goal) return;
  goal.taskId = plan?.id ?? null;
  goal.activeTaskItemId = plan ? (activeDoing(plan)?.id ?? null) : null;
};

const ensureSingleDoing = (plan: Task): void => {
  const doing = plan.items.filter((item) => item.status === "doing");
  if (doing.length > 1) {
    throw new Error(errorDetail("task_single_doing_conflict", { ids: doing.map((item) => item.id).join(", ") }));
  }
};

const setLedgerActive = (ledger: Ledger, plan: Task | null): void => {
  ledger.activeTaskId = plan && plan.status === "active" ? plan.id : null;
  ledger.activeTaskItemId = plan && plan.status === "active" ? (activeDoing(plan)?.id ?? null) : null;
  if (plan) syncGoalPlanPointers(ledger, plan.goalId, plan.status === "active" ? plan : null);
  else if (ledger.currentGoalId) syncGoalPlanPointers(ledger, ledger.currentGoalId, null);
};

const findPlan = (ledger: Ledger, taskId: string): Task => {
  const plan = ledger.tasks.find((row) => row.id === taskId);
  if (!plan) throw new Error(errorDetail("task_not_found", { id: taskId }));
  return plan;
};

/** Weak Goal↔Task: Task may stand alone; currentGoalId is only attached when active. */
const optionalActiveGoalId = (ledger: Ledger): string | null => {
  if (!ledger.currentGoalId) return null;
  const goal = ledger.goals.find((row) => row.id === ledger.currentGoalId);
  return goal && goal.status === "active" ? goal.id : null;
};

const touchPlan = (plan: Task): void => {
  plan.updatedAt = nowIso();
};

export function prepareTaskSet(dataDir: string, context: TaskContext, args: ToolArguments): {
  plan: Task;
  replacedPlanId?: string;
  history: TaskHistoryRecord[];
} {
  const { ledger } = context;
  const linkedGoalId = optionalActiveGoalId(ledger);
  const rawItems = Array.isArray(args.items) ? args.items : [];
  const items: TaskItem[] = [];
  const seenDoing: string[] = [];
  rawItems.forEach((raw, index) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    const text = String(row.text ?? "").trim();
    if (!text) throw new Error(errorDetail("task_item_text_empty", { index }));
    const status = row.status === "doing" || row.status === "done" ? row.status : "todo";
    if (status === "doing") seenDoing.push(text);
    const id = taskItemId(dataDir, ledger.conversationId);
    const item: TaskItem = {
      id,
      index,
      text,
      status: status as TaskItemStatus,
      createdAt: nowIso(),
    };
    if (typeof row.expectedEffect === "string" && row.expectedEffect.trim()) item.expectedEffect = row.expectedEffect.trim();
    if (typeof row.verification === "string" && row.verification.trim()) item.verification = row.verification.trim();
    if (status === "doing") item.startedAt = item.createdAt;
    if (status === "done") item.completedAt = item.createdAt;
    items.push(item);
  });
  if (!items.length) throw new Error(errorDetail("task_set_empty_items"));
  if (seenDoing.length > 1) {
    throw new Error(errorDetail("task_set_multi_doing_submit", { count: seenDoing.length, texts: seenDoing.join(", ") }));
  }

  // Replace whatever active task exists (goal-bound or standalone), not only goal.taskId.
  const previous = ledger.activeTaskId
    ? ledger.tasks.find((row) => row.id === ledger.activeTaskId && row.status === "active")
    : undefined;
  let replacedPlanId: string | undefined;
  const history: TaskHistoryRecord[] = [];
  if (previous) {
    replacedPlanId = previous.id;
    previous.status = "cancelled";
    previous.updatedAt = nowIso();
    touchPlan(previous);
    const record = {
      taskId: previous.id,
      goalId: previous.goalId ?? "",
      type: "task_cancelled" as const,
      reason: "replaced",
      before: { status: "active" },
      after: { status: "cancelled" },
    };
    pushHistory(dataDir, ledger, record, context.turnId);
    history.push(ledger.taskHistory.at(-1)!);
  }

  const taskId = allocateRecordId(dataDir, ledger.conversationId, "task");
  const now = nowIso();
  const plan: Task = {
    id: taskId,
    goalId: linkedGoalId,
    status: "active",
    items,
    createdAt: now,
    updatedAt: now,
    ...(typeof args.title === "string" && args.title.trim() ? { title: args.title.trim() } : {}),
  };
  ledger.tasks.push(plan);
  pushHistory(dataDir, ledger, {
    taskId: plan.id,
    goalId: plan.goalId ?? "",
    type: "task_created",
    after: { title: plan.title ?? null, itemCount: plan.items.length },
    ...(replacedPlanId ? { reason: `replaced:${replacedPlanId}` } : {}),
  }, context.turnId);
  history.push(ledger.taskHistory.at(-1)!);
  const doing = activeDoing(plan);
  if (doing) {
    pushHistory(dataDir, ledger, {
      taskId: plan.id,
      goalId: plan.goalId ?? "",
      taskItemId: doing.id,
      type: "item_started",
      after: { status: "doing" },
    }, context.turnId);
    history.push(ledger.taskHistory.at(-1)!);
  }
  setLedgerActive(ledger, plan);
  return { plan, ...(replacedPlanId ? { replacedPlanId } : {}), history };
}

export function prepareTaskUpdate(dataDir: string, context: TaskContext, args: ToolArguments): {
  plan: Task;
  history: TaskHistoryRecord[];
} {
  const { ledger } = context;
  const taskId = typeof args.taskId === "string" && args.taskId.trim() ? args.taskId.trim() : ledger.activeTaskId;
  if (!taskId) throw new Error(errorDetail("task_update_need_active"));
  const plan = findPlan(ledger, taskId);
  if (plan.status !== "active") throw new Error(errorDetail("task_update_terminal", { id: plan.id }));
  if (args.goalId !== undefined && args.goalId !== plan.goalId) {
    throw new Error(errorDetail("task_update_goal_mismatch"));
  }

  const raw = Array.isArray(args.items) ? args.items : [];
  if (!raw.length) throw new Error(errorDetail("task_update_empty_items"));
  const patches = raw.map((entry, i) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const itemId = typeof row.id === "string" && row.id.trim() ? row.id.trim() : "";
    if (!itemId) throw new Error(errorDetail("task_update_need_item_id", { index: i }));
    if (row.taskId !== undefined && row.taskId !== plan.id) {
      throw new Error(errorDetail("task_update_plan_mismatch"));
    }
    if (row.goalId !== undefined && row.goalId !== plan.goalId) {
      throw new Error(errorDetail("task_update_goal_id_mismatch"));
    }
    const status = row.status === "todo" || row.status === "doing" || row.status === "done"
      ? row.status as TaskItemStatus
      : undefined;
    const text = typeof row.text === "string" && row.text.trim() ? row.text.trim() : undefined;
    const expectedEffect = typeof row.expectedEffect === "string" && row.expectedEffect.trim()
      ? row.expectedEffect.trim()
      : undefined;
    const verification = typeof row.verification === "string" && row.verification.trim()
      ? row.verification.trim()
      : undefined;
    const blockedReason = typeof row.blockedReason === "string" && row.blockedReason.trim()
      ? row.blockedReason.trim()
      : undefined;
    if (!status && text === undefined && expectedEffect === undefined && verification === undefined && blockedReason === undefined) {
      throw new Error(errorDetail("task_update_patch_empty", { index: i }));
    }
    return { itemId, status, text, expectedEffect, verification, blockedReason };
  });

  const working = structuredClone(plan) as Task;
  const history: TaskHistoryRecord[] = [];
  for (const patch of patches) {
    const item = working.items.find((row) => row.id === patch.itemId);
    if (!item) throw new Error(errorDetail("task_item_missing", { id: patch.itemId, taskId: plan.id }));
    const before = structuredClone(item);
    const now = nowIso();
    if (patch.text !== undefined) item.text = patch.text;
    if (patch.expectedEffect !== undefined) item.expectedEffect = patch.expectedEffect;
    else if (patch.expectedEffect === undefined && "expectedEffect" in patch) delete item.expectedEffect;
    if (patch.verification !== undefined) item.verification = patch.verification;
    if (patch.blockedReason !== undefined) item.blockedReason = patch.blockedReason;
    if (patch.status !== undefined && patch.status !== item.status) {
      if (item.status === "done" && patch.status !== "done") {
        throw new Error(errorDetail("task_item_done_no_rollback", { id: item.id }));
      }
      if (patch.status === "doing") {
        const other = working.items.find((row) => row.status === "doing" && row.id !== item.id);
        if (other) {
          throw new Error(errorDetail("task_multi_doing_update", { a: other.id, b: item.id }));
        }
        item.status = "doing";
        item.startedAt ??= now;
        delete item.blockedReason;
      } else if (patch.status === "done") {
        item.status = "done";
        item.completedAt = now;
        delete item.blockedReason;
      } else {
        item.status = "todo";
        delete item.startedAt;
        delete item.completedAt;
      }
    } else if (patch.blockedReason !== undefined && item.status === "doing") {
      item.blockedReason = patch.blockedReason;
    }
    item.index = before.index;
    if (JSON.stringify(before) === JSON.stringify(item)) continue;
    touchPlan(working);
    const type = item.status === "doing" && before.status !== "doing"
      ? "item_started" as const
      : item.status === "done" && before.status !== "done"
        ? "item_completed" as const
        : "item_updated" as const;
    pushHistory(dataDir, ledger, {
      taskId: working.id,
      goalId: working.goalId ?? "",
      taskItemId: item.id,
      type,
      before,
      after: structuredClone(item),
      ...(item.blockedReason ? { reason: item.blockedReason } : {}),
    }, context.turnId);
    history.push(ledger.taskHistory.at(-1)!);
  }
  ensureSingleDoing(working);
  const index = ledger.tasks.findIndex((row) => row.id === working.id);
  ledger.tasks[index] = working;
  setLedgerActive(ledger, working);
  return { plan: working, history };
}

export function prepareTaskComplete(dataDir: string, context: TaskContext, args: ToolArguments): {
  plan: Task;
  history: TaskHistoryRecord[];
} {
  const { ledger } = context;
  const taskId = typeof args.taskId === "string" && args.taskId.trim() ? args.taskId.trim() : ledger.activeTaskId;
  if (!taskId) throw new Error(errorDetail("task_complete_need_active"));
  const plan = findPlan(ledger, taskId);
  if (plan.status === "completed") return { plan, history: [] };
  if (plan.status === "cancelled") throw new Error(errorDetail("task_complete_cancelled", { id: plan.id }));
  const unfinished = plan.items.filter((item) => item.status !== "done");
  if (unfinished.length) {
    throw new Error(errorDetail("task_complete_unfinished", { ids: unfinished.map((item) => item.id).join(", ") }));
  }
  const before = { status: plan.status };
  plan.status = "completed";
  plan.completedAt = nowIso();
  touchPlan(plan);
  pushHistory(dataDir, ledger, {
    taskId: plan.id,
    goalId: plan.goalId ?? "",
    type: "task_completed",
    before,
    after: { status: "completed" },
    ...(typeof args.reason === "string" && args.reason.trim() ? { reason: args.reason.trim() } : {}),
  }, context.turnId);
  setLedgerActive(ledger, plan);
  if (ledger.activeTaskId === plan.id) {
    ledger.activeTaskId = null;
    ledger.activeTaskItemId = null;
    syncGoalPlanPointers(ledger, plan.goalId, null);
  }
  return { plan, history: [ledger.taskHistory.at(-1)!] };
}

export function endTasksForGoal(dataDir: string, ledger: Ledger, goal: GoalRecord, reason: "goal_ended" | "replaced", turnId: string): void {
  const open = ledger.tasks.filter((row) => row.goalId === goal.id && row.status === "active");
  for (const plan of open) {
    plan.status = "cancelled";
    plan.updatedAt = nowIso();
    pushHistory(dataDir, ledger, {
      taskId: plan.id,
      goalId: plan.goalId ?? "",
      type: "task_cancelled",
      reason,
      before: { status: "active" },
      after: { status: "cancelled" },
    }, turnId);
  }
  goal.taskId = null;
  goal.activeTaskItemId = null;
  if (ledger.activeTaskId && open.some((row) => row.id === ledger.activeTaskId)) {
    ledger.activeTaskId = null;
    ledger.activeTaskItemId = null;
  }
}

function appendGoalTerminalHistory(dataDir: string, ledger: Ledger, goal: GoalRecord, turnId: string): void {
  if (goal.status === "active") return;
  const taskId = goal.taskId
    ?? [...ledger.tasks].reverse().find((row) => row.goalId === goal.id)?.id;
  if (!taskId) return;
  const type = goal.status === "completed" ? "goal_completed" : "goal_cancelled";
  const exists = ledger.taskHistory.some((row) =>
    row.goalId === goal.id && row.type === type && row.after !== undefined &&
    (row.after as { status?: string } | undefined)?.status === goal.status);
  if (exists) return;
  pushHistory(dataDir, ledger, {
    taskId,
    goalId: goal.id,
    type,
    after: { status: goal.status },
  }, turnId);
}

export function afterGoalSwitch(dataDir: string, ledger: Ledger, previousGoalId: string | null, nextGoalId: string | null, turnId: string): void {
  if (previousGoalId && previousGoalId !== nextGoalId) {
    const previous = ledger.goals.find((row) => row.id === previousGoalId);
    if (previous && previous.status !== "active") {
      endTasksForGoal(dataDir, ledger, previous, "goal_ended", turnId);
      appendGoalTerminalHistory(dataDir, ledger, previous, turnId);
    }
  }
  // Weak link: goal switches never clear a standalone (goalId=null) active task.
  // Only retarget when the next active goal has its own bound task.
  if (!nextGoalId) return;
  const next = ledger.goals.find((row) => row.id === nextGoalId);
  if (!next || next.status !== "active") return;
  const plan = next.taskId ? ledger.tasks.find((row) => row.id === next.taskId && row.status === "active") : undefined;
  if (plan) setLedgerActive(ledger, plan);
}

/** Goal terminal transition: cancel open tasks then append goal history. */
export function onGoalStatusChange(dataDir: string, ledger: Ledger, previous: GoalRecord | undefined, record: GoalRecord, turnId: string): void {
  if (previous && previous.status === "active" && record.status !== "active") {
    endTasksForGoal(dataDir, ledger, record, "goal_ended", turnId);
    appendGoalTerminalHistory(dataDir, ledger, record, turnId);
  } else if (!previous && record.status !== "active") {
    appendGoalTerminalHistory(dataDir, ledger, record, turnId);
  }
}

export function executionContext(ledger: Ledger): RuntimeExecutionContext {
  return {
    goalId: ledger.currentGoalId,
    activeTaskId: ledger.activeTaskId,
    activeTaskItemId: ledger.activeTaskItemId,
  };
}
