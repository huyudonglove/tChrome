import type { GoalRecord, Ledger, Plan, PlanHistoryRecord, PlanItem, PlanItemStatus, ToolArguments } from "../types.ts";
import { allocateRecordId, nowIso } from "./ids.ts";

export type PlanContext = {
  ledger: Ledger;
  turnId: string;
  sourceCallId: string;
};

const historyId = (dataDir: string, conversationId: string) =>
  allocateRecordId(dataDir, conversationId, "planHistory");

const planItemId = (dataDir: string, conversationId: string) =>
  allocateRecordId(dataDir, conversationId, "planItem");

const pushHistory = (
  dataDir: string,
  ledger: Ledger,
  row: Omit<PlanHistoryRecord, "id" | "at"> & { at?: string; turnId?: string },
  turnId: string,
): void => {
  ledger.planHistory.push({
    id: historyId(dataDir, ledger.conversationId),
    at: row.at ?? nowIso(),
    turnId,
    ...row,
  });
};

const activeDoing = (plan: Plan): PlanItem | null =>
  plan.items.find((item) => item.status === "doing") ?? null;

const syncGoalPlanPointers = (ledger: Ledger, goalId: string | null, plan: Plan | null): void => {
  if (!goalId) return;
  const goal = ledger.goals.find((row) => row.id === goalId);
  if (!goal) return;
  goal.planId = plan?.id ?? null;
  goal.activePlanItemId = plan ? (activeDoing(plan)?.id ?? null) : null;
};

const ensureSingleDoing = (plan: Plan): void => {
  const doing = plan.items.filter((item) => item.status === "doing");
  if (doing.length > 1) {
    throw new Error(`同一 Plan 最多一个 doing 项，当前冲突：${doing.map((item) => item.id).join(", ")}`);
  }
};

const setLedgerActive = (ledger: Ledger, plan: Plan | null): void => {
  ledger.activePlanId = plan && plan.status === "active" ? plan.id : null;
  ledger.activePlanItemId = plan && plan.status === "active" ? (activeDoing(plan)?.id ?? null) : null;
  if (plan) syncGoalPlanPointers(ledger, plan.goalId, plan.status === "active" ? plan : null);
  else if (ledger.currentGoalId) syncGoalPlanPointers(ledger, ledger.currentGoalId, null);
};

const findPlan = (ledger: Ledger, planId: string): Plan => {
  const plan = ledger.plans.find((row) => row.id === planId);
  if (!plan) throw new Error(`Plan ${planId} 不存在`);
  return plan;
};

const requireGoal = (ledger: Ledger): GoalRecord => {
  if (!ledger.currentGoalId) throw new Error("需要先用 submitGoal 创建或切换当前 Goal，再创建 Plan");
  const goal = ledger.goals.find((row) => row.id === ledger.currentGoalId);
  if (!goal) throw new Error(`当前 Goal ${ledger.currentGoalId} 不存在`);
  if (goal.status !== "active") throw new Error(`Goal ${goal.id} 已结束，不能挂接 Plan`);
  return goal;
};

const touchPlan = (plan: Plan): void => {
  plan.updatedAt = nowIso();
};

export function preparePlanSet(dataDir: string, context: PlanContext, args: ToolArguments): {
  plan: Plan;
  replacedPlanId?: string;
  history: PlanHistoryRecord[];
} {
  const { ledger } = context;
  const goal = requireGoal(ledger);
  const rawItems = Array.isArray(args.items) ? args.items : [];
  const items: PlanItem[] = [];
  const seenDoing: string[] = [];
  rawItems.forEach((raw, index) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    const text = String(row.text ?? "").trim();
    if (!text) throw new Error(`items[${index}].text 不能为空`);
    const status = row.status === "doing" || row.status === "done" ? row.status : "todo";
    if (status === "doing") seenDoing.push(text);
    const id = planItemId(dataDir, ledger.conversationId);
    const item: PlanItem = {
      id,
      index,
      text,
      status: status as PlanItemStatus,
      createdAt: nowIso(),
    };
    if (typeof row.expectedEffect === "string" && row.expectedEffect.trim()) item.expectedEffect = row.expectedEffect.trim();
    if (typeof row.verification === "string" && row.verification.trim()) item.verification = row.verification.trim();
    if (status === "doing") item.startedAt = item.createdAt;
    if (status === "done") item.completedAt = item.createdAt;
    items.push(item);
  });
  if (!items.length) throw new Error("plan.set 需要非空 items");
  if (seenDoing.length > 1) {
    throw new Error(`同一 Plan 最多一个 doing 项，提交中出现 ${seenDoing.length} 项：${seenDoing.join(", ")}`);
  }

  const previous = goal.planId ? ledger.plans.find((row) => row.id === goal.planId && row.status === "active") : undefined;
  let replacedPlanId: string | undefined;
  const history: PlanHistoryRecord[] = [];
  if (previous) {
    replacedPlanId = previous.id;
    previous.status = "cancelled";
    previous.updatedAt = nowIso();
    touchPlan(previous);
    const record = {
      planId: previous.id,
      goalId: previous.goalId,
      type: "plan_cancelled" as const,
      reason: "replaced",
      before: { status: "active" },
      after: { status: "cancelled" },
    };
    pushHistory(dataDir, ledger, record, context.turnId);
    history.push(ledger.planHistory.at(-1)!);
  }

  const planId = allocateRecordId(dataDir, ledger.conversationId, "plan");
  const now = nowIso();
  const plan: Plan = {
    id: planId,
    goalId: goal.id,
    status: "active",
    items,
    createdAt: now,
    updatedAt: now,
    ...(typeof args.title === "string" && args.title.trim() ? { title: args.title.trim() } : {}),
  };
  ledger.plans.push(plan);
  pushHistory(dataDir, ledger, {
    planId: plan.id,
    goalId: plan.goalId,
    type: "plan_created",
    after: { title: plan.title ?? null, itemCount: plan.items.length },
    ...(replacedPlanId ? { reason: `replaced:${replacedPlanId}` } : {}),
  }, context.turnId);
  history.push(ledger.planHistory.at(-1)!);
  const doing = activeDoing(plan);
  if (doing) {
    pushHistory(dataDir, ledger, {
      planId: plan.id,
      goalId: plan.goalId,
      planItemId: doing.id,
      type: "item_started",
      after: { status: "doing" },
    }, context.turnId);
    history.push(ledger.planHistory.at(-1)!);
  }
  setLedgerActive(ledger, plan);
  return { plan, ...(replacedPlanId ? { replacedPlanId } : {}), history };
}

export function preparePlanUpdate(dataDir: string, context: PlanContext, args: ToolArguments): {
  plan: Plan;
  history: PlanHistoryRecord[];
} {
  const { ledger } = context;
  const planId = typeof args.planId === "string" && args.planId.trim() ? args.planId.trim() : ledger.activePlanId;
  if (!planId) throw new Error("plan.update 需要活动 Plan；先用 plan.set 创建");
  const plan = findPlan(ledger, planId);
  if (plan.status !== "active") throw new Error(`Plan ${plan.id} 已是终态，不能更新`);
  if (args.goalId !== undefined && args.goalId !== plan.goalId) {
    throw new Error("plan.update 不能改写 goalId；Runtime 已自动关联");
  }

  const raw = Array.isArray(args.items) ? args.items : [];
  if (!raw.length) throw new Error("plan.update 需要非空 items");
  const patches = raw.map((entry, i) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const itemId = typeof row.id === "string" && row.id.trim() ? row.id.trim() : "";
    if (!itemId) throw new Error(`items[${i}].id 必须是稳定 planItemId`);
    if (row.planId !== undefined && row.planId !== plan.id) {
      throw new Error("items[].planId 与当前 Plan 不一致；Runtime 已自动关联");
    }
    if (row.goalId !== undefined && row.goalId !== plan.goalId) {
      throw new Error("items[].goalId 与当前 Plan 不一致；Runtime 已自动关联");
    }
    const status = row.status === "todo" || row.status === "doing" || row.status === "done"
      ? row.status as PlanItemStatus
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
      throw new Error(`items[${i}] 至少需要 status 或 text/expectedEffect/verification/blockedReason 之一`);
    }
    return { itemId, status, text, expectedEffect, verification, blockedReason };
  });

  const working = structuredClone(plan) as Plan;
  const history: PlanHistoryRecord[] = [];
  for (const patch of patches) {
    const item = working.items.find((row) => row.id === patch.itemId);
    if (!item) throw new Error(`PlanItem ${patch.itemId} 不存在于 ${plan.id}`);
    const before = structuredClone(item);
    const now = nowIso();
    if (patch.text !== undefined) item.text = patch.text;
    if (patch.expectedEffect !== undefined) item.expectedEffect = patch.expectedEffect;
    else if (patch.expectedEffect === undefined && "expectedEffect" in patch) delete item.expectedEffect;
    if (patch.verification !== undefined) item.verification = patch.verification;
    if (patch.blockedReason !== undefined) item.blockedReason = patch.blockedReason;
    if (patch.status !== undefined && patch.status !== item.status) {
      if (item.status === "done" && patch.status !== "done") {
        throw new Error(`PlanItem ${item.id} 已 done，不能回退`);
      }
      if (patch.status === "doing") {
        const other = working.items.find((row) => row.status === "doing" && row.id !== item.id);
        if (other) {
          throw new Error(`同一 Plan 最多一个 doing 项，冲突：${other.id} 与 ${item.id}`);
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
      planId: working.id,
      goalId: working.goalId,
      planItemId: item.id,
      type,
      before,
      after: structuredClone(item),
      ...(item.blockedReason ? { reason: item.blockedReason } : {}),
    }, context.turnId);
    history.push(ledger.planHistory.at(-1)!);
  }
  ensureSingleDoing(working);
  const index = ledger.plans.findIndex((row) => row.id === working.id);
  ledger.plans[index] = working;
  setLedgerActive(ledger, working);
  return { plan: working, history };
}

export function preparePlanComplete(dataDir: string, context: PlanContext, args: ToolArguments): {
  plan: Plan;
  history: PlanHistoryRecord[];
} {
  const { ledger } = context;
  const planId = typeof args.planId === "string" && args.planId.trim() ? args.planId.trim() : ledger.activePlanId;
  if (!planId) throw new Error("plan.complete 需要活动 Plan");
  const plan = findPlan(ledger, planId);
  if (plan.status === "completed") return { plan, history: [] };
  if (plan.status === "cancelled") throw new Error(`Plan ${plan.id} 已 cancelled，不能 complete`);
  const unfinished = plan.items.filter((item) => item.status !== "done");
  if (unfinished.length) {
    throw new Error(`Plan 还有未完成步骤：${unfinished.map((item) => item.id).join(", ")}`);
  }
  const before = { status: plan.status };
  plan.status = "completed";
  plan.completedAt = nowIso();
  touchPlan(plan);
  pushHistory(dataDir, ledger, {
    planId: plan.id,
    goalId: plan.goalId,
    type: "plan_completed",
    before,
    after: { status: "completed" },
    ...(typeof args.reason === "string" && args.reason.trim() ? { reason: args.reason.trim() } : {}),
  }, context.turnId);
  setLedgerActive(ledger, plan);
  if (ledger.activePlanId === plan.id) {
    ledger.activePlanId = null;
    ledger.activePlanItemId = null;
    syncGoalPlanPointers(ledger, plan.goalId, null);
  }
  return { plan, history: [ledger.planHistory.at(-1)!] };
}

export function endPlansForGoal(dataDir: string, ledger: Ledger, goal: GoalRecord, reason: "goal_ended" | "replaced", turnId: string): void {
  const open = ledger.plans.filter((row) => row.goalId === goal.id && row.status === "active");
  for (const plan of open) {
    plan.status = "cancelled";
    plan.updatedAt = nowIso();
    pushHistory(dataDir, ledger, {
      planId: plan.id,
      goalId: plan.goalId,
      type: "plan_cancelled",
      reason,
      before: { status: "active" },
      after: { status: "cancelled" },
    }, turnId);
  }
  goal.planId = null;
  goal.activePlanItemId = null;
  if (ledger.activePlanId && open.some((row) => row.id === ledger.activePlanId)) {
    ledger.activePlanId = null;
    ledger.activePlanItemId = null;
  }
}

function appendGoalTerminalHistory(dataDir: string, ledger: Ledger, goal: GoalRecord, turnId: string): void {
  if (goal.status === "active") return;
  const planId = goal.planId
    ?? [...ledger.plans].reverse().find((row) => row.goalId === goal.id)?.id;
  if (!planId) return;
  const type = goal.status === "completed" ? "goal_completed" : "goal_cancelled";
  const exists = ledger.planHistory.some((row) =>
    row.goalId === goal.id && row.type === type && row.after !== undefined &&
    (row.after as { status?: string } | undefined)?.status === goal.status);
  if (exists) return;
  pushHistory(dataDir, ledger, {
    planId,
    goalId: goal.id,
    type,
    after: { status: goal.status },
  }, turnId);
}

export function afterGoalSwitch(dataDir: string, ledger: Ledger, previousGoalId: string | null, nextGoalId: string | null, turnId: string): void {
  if (previousGoalId && previousGoalId !== nextGoalId) {
    const previous = ledger.goals.find((row) => row.id === previousGoalId);
    if (previous && previous.status !== "active") {
      endPlansForGoal(dataDir, ledger, previous, "goal_ended", turnId);
      appendGoalTerminalHistory(dataDir, ledger, previous, turnId);
    }
  }
  if (!nextGoalId) {
    ledger.activePlanId = null;
    ledger.activePlanItemId = null;
    return;
  }
  const next = ledger.goals.find((row) => row.id === nextGoalId);
  if (!next || next.status !== "active") {
    ledger.activePlanId = null;
    ledger.activePlanItemId = null;
    return;
  }
  const plan = next.planId ? ledger.plans.find((row) => row.id === next.planId && row.status === "active") : undefined;
  setLedgerActive(ledger, plan ?? null);
}

/** Goal terminal transition: cancel open plans then append goal history. */
export function onGoalStatusChange(dataDir: string, ledger: Ledger, previous: GoalRecord | undefined, record: GoalRecord, turnId: string): void {
  if (previous && previous.status === "active" && record.status !== "active") {
    endPlansForGoal(dataDir, ledger, record, "goal_ended", turnId);
    appendGoalTerminalHistory(dataDir, ledger, record, turnId);
  } else if (!previous && record.status !== "active") {
    appendGoalTerminalHistory(dataDir, ledger, record, turnId);
  }
}

export function executionContext(ledger: Ledger): RuntimeExecutionContext {
  return {
    goalId: ledger.currentGoalId,
    activePlanId: ledger.activePlanId,
    activePlanItemId: ledger.activePlanItemId,
  };
}
