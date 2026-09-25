/** Tools that may run without an active Task (closers, goal/meta, memory, skills). */
export const TASK_EXEMPT = new Set<string>([
  "askUser",
  "finishTurn",
  "checkContinue",
  "reportProgress",
  "submitGoal",
  "task.set",
  "task.update",
  "task.complete",
  "skill.list",
  "skill.load",
  "catalog.add",
  "list_browser_tools",
  "notes.write",
  "notes.delete",
  "memory.write",
  "memory.update",
  "memory.delete",
  "reflect.write",
  "reflect.delete",
  "context.query",
  "agent.query",
  "agent.compress",
  "job.status",
  "job.stop",
  "tab.context",
]);

export function requiresActiveTask(name: string): boolean {
  return !TASK_EXEMPT.has(name);
}
