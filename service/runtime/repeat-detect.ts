import type { ToolIOItem } from "../types.ts";

/** Sliding window: hints inspect the last N tool rows of the turn, not only the last two. */
export const REPEAT_WINDOW = 8;
/** Equivalent-argument repeats of one tool inside the window (hint only, never blocks). */
export const REPEAT_CALL_LIMIT = 2;
/** Same tool called this many times inside the window, whatever the arguments. */
export const REPEAT_TOOL_LIMIT = 4;
/** Same faultCode this many times inside the window. The message is deliberately ignored. */
export const REPEAT_FAULT_LIMIT = 2;
/** Framing arguments differ between two attempts at the same action, so they do not count. */
const FRAMING_KEYS = new Set(["x", "y", "width", "height"]);
/** Stable marker per rule: a rule fires at most once per turn. */
const RULE_MARKERS = {
  call: "runtime[repeat:call]",
  tool: "runtime[repeat:tool]",
  fault: "runtime[repeat:fault]",
} as const;

/** Stable stringify so key order never makes two identical calls look different. */
function fingerprint(args: unknown, ignoreFraming = false): string {
  if (args === null || typeof args !== "object") return JSON.stringify(args ?? null) ?? "null";
  if (Array.isArray(args)) return `[${args.map((item) => fingerprint(item, ignoreFraming)).join(",")}]`;
  const entries = Object.entries(args as Record<string, unknown>)
    .filter(([key, value]) => value !== undefined)
    .filter(([key]) => !(ignoreFraming && FRAMING_KEYS.has(key)))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${JSON.stringify(key)}:${fingerprint(value, ignoreFraming)}`);
  return `{${entries.join(",")}}`;
}

/** Pull faultCode / message out of a tool row without depending on the return shape. */
export function failureSignature(row: ToolIOItem): string | undefined {
  const text = row.return?.text;
  if (typeof text !== "string" || !text.includes("faultCode")) return undefined;
  try {
    const parsed = JSON.parse(text) as { faultCode?: unknown; message?: unknown; details?: { reason?: unknown } };
    const faultCode = typeof parsed.faultCode === "string" ? parsed.faultCode : undefined;
    if (!faultCode) return undefined;
    const message = typeof parsed.message === "string" ? parsed.message : "";
    return `${faultCode}::${message}`;
  } catch {
    const match = /"faultCode"\s*:\s*"([^"]+)"/.exec(text);
    return match ? `${match[1]}::` : undefined;
  }
}

/** faultCode only; the message is not part of the signature so per-request ids still match. */
function faultCodeOf(row: ToolIOItem): string | undefined {
  return failureSignature(row)?.split("::")[0];
}

/**
 * Sliding-window repeat detection, hint only (never blocks). Inspects the last
 * REPEAT_WINDOW rows of the turn so a loop that alternates tools, or that keeps
 * re-shooting with different framing coordinates, is still caught. Three rules,
 * each firing at most once per turn (a fired marker is already in some row):
 * 1. call: the same tool appears REPEAT_CALL_LIMIT times with equivalent arguments
 *    (framing keys such as x/y/width/height are ignored, so re-cropping the same
 *    region counts as a replay rather than a new attempt);
 * 2. tool: the same tool appears REPEAT_TOOL_LIMIT times with any arguments;
 * 3. fault: the same faultCode shows up REPEAT_FAULT_LIMIT times in the window.
 */
export function repeatHint(rows: ToolIOItem[]): string | undefined {
  if (rows.length < REPEAT_CALL_LIMIT) return undefined;
  const window = rows.slice(-REPEAT_WINDOW);
  const current = window[window.length - 1]!;
  const alreadyFired = (marker: string): boolean => rows.some((row) => row.return?.text?.includes(marker));

  const byTool = window.filter((row) => row.name === current.name);
  if (!alreadyFired(RULE_MARKERS.call)) {
    const equivalent = byTool.filter((row) => fingerprint(row.arguments, true) === fingerprint(current.arguments, true));
    if (equivalent.length >= REPEAT_CALL_LIMIT) {
      return `${RULE_MARKERS.call} runtime: 最近 ${window.length} 次调用中已第 ${equivalent.length} 次以等价参数调用 ${current.name}。先确认上一次是否已生效；若要换路径就改参数或换方法，不要原样重放。`;
    }
  }
  if (!alreadyFired(RULE_MARKERS.tool) && byTool.length >= REPEAT_TOOL_LIMIT) {
    return `${RULE_MARKERS.tool} runtime: 最近 ${window.length} 次调用中 ${current.name} 已连续/累计出现 ${byTool.length} 次。若仍在原地重试同一路径，请先换方法或向用户说明卡点。`;
  }
  if (!alreadyFired(RULE_MARKERS.fault)) {
    const currentFault = faultCodeOf(current);
    if (currentFault) {
      const faults = window.filter((row) => faultCodeOf(row) === currentFault);
      if (faults.length >= REPEAT_FAULT_LIMIT) {
        return `${RULE_MARKERS.fault} runtime: 最近 ${window.length} 次调用中已第 ${faults.length} 次收到同一个错误（faultCode=${currentFault}）。先读错误里的 details/recovery 改参数或换方法，不要继续用同样的调用。`;
      }
    }
  }
  return undefined;
}
