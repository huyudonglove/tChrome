/**
 * Task gate is risk-driven: only high-risk calls need an active Task.
 * Tools may carry a fixed risk in capability metadata; uncertain calls declare `risk`.
 */
export type ToolRisk = "low" | "medium" | "high";

const asRisk = (value: unknown): ToolRisk | undefined =>
  value === "low" || value === "medium" || value === "high" ? value : undefined;

/** Fixed high always requires a Task; model may escalate any call to high via `risk`. */
export function requiresActiveTask(fixedRisk?: string, modelRisk?: unknown): boolean {
  return fixedRisk === "high" || asRisk(modelRisk) === "high";
}
