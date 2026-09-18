import type { GoalRecord, ToolArguments } from "../types.ts";
import { allocateRecordId, nowIso } from "./ids.ts";

export type GoalContext = {
  goals: GoalRecord[];
  currentGoalId: string | null;
  turnId: string;
  sourceCallId: string;
};

/** Prepare one explicit goal mutation; runtime effects own persistence. */
export function prepareGoalUpdate(dataDir: string, conversationId: string, context: GoalContext, args: ToolArguments): {
  record: GoalRecord;
  currentGoalId: string | null;
} {
  if (args.id !== undefined && (typeof args.id !== "string" || !args.id.trim())) throw new Error("id 必须是已有目标的非空 ID；创建目标时省略 id。");
  if (args.goal !== undefined && (typeof args.goal !== "string" || !args.goal.trim())) throw new Error("goal 必须是非空字符串。");
  if (args.status !== undefined && !["active", "completed", "cancelled"].includes(args.status as string)) throw new Error("status 只能是 active、completed 或 cancelled。");
  if (args.parentId !== undefined && (typeof args.parentId !== "string" || !args.parentId.trim())) throw new Error("parentId 必须是总目标 ID；创建总目标时省略 parentId。");
  const existing = args.id === undefined ? undefined : context.goals.find(record => record.id === args.id);
  if (args.id !== undefined && !existing) throw new Error(`目标 ${args.id} 不存在；请使用 <goal> 或 <goalHistory> 中的 ID。`);
  if (existing && args.parentId !== undefined && args.parentId !== existing.parentId) throw new Error("已有目标的父级关系不可修改；请保留 parentId 或省略该参数。");
  const parentId = existing ? existing.parentId : args.parentId as string | undefined;
  const parent = parentId ? context.goals.find(record => record.id === parentId) : undefined;
  if (parentId && (!parent || parent.parentId !== null)) throw new Error(`parentId ${parentId} 必须指向已有总目标，不能指向子目标。`);
  if (!existing && args.goal === undefined) throw new Error("创建目标必须提供 goal；更新已有目标请提供 id。");
  const timestamp = nowIso();
  const record: GoalRecord = {
    id: existing?.id ?? allocateRecordId(dataDir, conversationId, parentId ? "subgoal" : "goal"),
    parentId: parentId ?? null,
    goal: args.goal === undefined ? existing!.goal : (args.goal as string).trim(),
    status: (args.status as GoalRecord["status"] | undefined) ?? existing?.status ?? "active",
    turnId: context.turnId,
    sourceCallId: context.sourceCallId,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  const currentGoalId = record.status === "active" ? record.id
    : context.currentGoalId === record.id ? (parent?.status === "active" ? parent.id : null)
    : context.currentGoalId;
  return { record, currentGoalId };
}
