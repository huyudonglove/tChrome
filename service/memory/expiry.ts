import type { Task } from "../types.ts";
import type { ExpiryCondition, MemoryRecord } from "./types.ts";

/** True when the referenced task event has already happened.
 *  Runtime owns the task ledger, so expiry is judged from persisted state, not from the
 *  write call's intent. */
export function conditionMet(condition: ExpiryCondition, tasks: readonly Task[]): boolean {
  const task = tasks.find((item) => item.id === condition.taskId);
  if (!task) return false;
  if (condition.on === "task_cancelled") return task.status === "cancelled";
  if (condition.on === "task_complete") return task.status === "completed";
  if (!condition.itemId) return false;
  return task.items.some((item) => item.id === condition.itemId && item.status === "done");
}

/** A record expires once any of its conditions is met.
 *  Project memories are owned by the conversation that wrote them: every conversation numbers its
 *  tasks from task_01, so a project memory bound to `task_04` must not be retired by another
 *  conversation's unrelated `task_04`. */
export function isExpired(record: MemoryRecord, tasks: readonly Task[], conversationId: string): boolean {
  if (!record.expiresWhen?.length) return false;
  if (record.layer === "project" && record.sourceConversationId !== conversationId) return false;
  return record.expiresWhen.some((condition) => conditionMet(condition, tasks));
}
