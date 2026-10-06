import type { SubagentResult, TaskPacket } from "./types.ts";

/**
 * Keep the stable role rules in code and send only the dynamic packet as data.
 * JSON is deliberately used inside one tag so task text cannot redefine the envelope.
 */
export function buildTaskPrompt(
  packet: TaskPacket,
  dependencyResults: readonly SubagentResult[] = [],
): string {
  return `<subagentTask>\n${JSON.stringify({ packet, dependencyResults })}\n</subagentTask>`;
}
