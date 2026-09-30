import { ENVIRONMENT_FAULTS } from "../../shared/errors.ts";
import type { ToolIOItem } from "../types.ts";
import { runtimeConfig } from "../config/runtime.ts";

// Thresholds live in service/config/runtime.json (gates.context) so every "how many rows"
// budget has one source; the aliases below keep the call sites readable.
const g = runtimeConfig.context;

/** Sliding window: hints inspect the last N tool rows of the turn, not only the last two. */
export const REPEAT_WINDOW = g.repeatWindow;
/** Equivalent-argument repeats of one tool inside the window (hint only, never blocks). */
export const REPEAT_CALL_LIMIT = g.repeatCallLimit;
/** Same tool called this many times inside the window, whatever the arguments. */
export const REPEAT_TOOL_LIMIT = g.repeatToolLimit;
/** Same faultCode this many times inside the window. The message is deliberately ignored. */
export const REPEAT_FAULT_LIMIT = g.repeatFaultLimit;
/** Framing arguments differ between two attempts at the same action, so they do not count. */
const FRAMING_KEYS = new Set(["x", "y", "width", "height"]);
/** Stable marker per rule: a rule fires at most once per turn. */
const RULE_MARKERS = {
  call: "runtime[repeat:call]",
  tool: "runtime[repeat:tool]",
  fault: "runtime[repeat:fault]",
  faultMemory: "runtime[first-fault:memory]",
} as const;
/**
 * Faults whose root cause lives outside the current call (host environment, extension
 * build, service version, broken bridge). Declared as data in shared/fault-metadata.json
 * (scope: "environment") and derived in shared/errors.ts, so declaring a new environment
 * fault is a data edit, not a code edit here. Design-internal failures
 * (task_gate_required, assertion_failed, correct_arguments, missing_required) are
 * deliberately absent: a hint to write them down would be noise.
 */
export const DIAGNOSABLE_FAULTS = ENVIRONMENT_FAULTS;

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
export function faultCodeOf(row: ToolIOItem): string | undefined {
  return failureSignature(row)?.split("::")[0];
}

/** Clip a restated failure string so the hint stays one readable line. */
function clip(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Human-facing part of a failure: what went wrong plus the direction the tool itself
 * offered. A repeat hint that only names the faultCode leaves the model guessing why
 * the same call keeps failing, so the hint restates these instead of "you saw this
 * error again".
 */
export function failureDetail(row: ToolIOItem): string | undefined {
  const text = row.return?.text;
  if (typeof text !== "string" || !text.includes("faultCode")) return undefined;
  try {
    const parsed = JSON.parse(text) as { message?: unknown; recovery?: unknown; details?: { reason?: unknown } };
    const pick = (value: unknown): string | undefined =>
      typeof value === "string" && value.trim() ? value.trim() : undefined;
    const parts: string[] = [];
    const message = pick(parsed.message);
    if (message) parts.push(`原因 ${clip(message)}`);
    const recovery = pick(parsed.recovery);
    if (recovery) parts.push(`工具给的处置方向 ${recovery}`);
    const reason = pick(parsed.details?.reason);
    if (reason) parts.push(clip(reason));
    return parts.length ? parts.join("；") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sliding-window repeat detection, hint only (never blocks). Inspects the last
 * REPEAT_WINDOW rows of the turn so a loop that alternates tools, or that keeps
 * re-shooting with different framing coordinates, is still caught. Four rules,
 * each firing at most once per turn (a fired marker is already in some row):
 * 1. call: the same tool appears REPEAT_CALL_LIMIT times with equivalent arguments
 *    (framing keys such as x/y/width/height are ignored, so re-cropping the same
 *    region counts as a replay rather than a new attempt);
 * 2. tool: the same tool appears REPEAT_TOOL_LIMIT times with any arguments;
 * 3. fault: the same faultCode shows up REPEAT_FAULT_LIMIT times in the window.
 */
export function repeatHint(rows: ToolIOItem[], history: ToolIOItem[] = rows): string | undefined {
  const current = rows[rows.length - 1];
  if (!current) return undefined;
  const alreadyFired = (marker: string): boolean => rows.some((row) => row.return?.text?.includes(marker));
  // A diagnosable fault that never appeared before is worth writing down: the next time it
  // shows up nothing will recall this occurrence, and similar symptoms routinely have
  // opposite causes. history is the whole-conversation toolIO; default rows = this turn.
  if (!alreadyFired(RULE_MARKERS.faultMemory)) {
    const fault = faultCodeOf(current);
    // The current row is already in history (loop.ts pushes it before calling us), so it must be
    // excluded or every fault would count as "seen before" and the rule would never fire. Compare
    // by callId rather than object identity: the same row object can legitimately appear twice.
    const seenBefore = (code: string): boolean => history.some((row) => row.callId !== current.callId && faultCodeOf(row) === code);
    if (fault && DIAGNOSABLE_FAULTS.has(fault) && !seenBefore(fault)) {
      return `${RULE_MARKERS.faultMemory} runtime: 本轮首次遇到故障 ${fault}。这类故障的根因不在这次调用里（宿主环境、扩展构建、服务版本或桥接），处置经验不会自己出现在记忆中——下次症状可能相似、根因和动作却相反，所以那时不会去翻其他故障的处置。如果你已经定位清楚根因，请用 memory.write 写一条 projectMemory，把三段记清楚：症状（怎么发现的、表现是什么）→ 根因（真实原因、代码位置）→ 处置（怎么修的、下次先做什么）。没定位清楚就不要写。这只是提示，不阻断排查。`;
    }
  }
  if (rows.length < REPEAT_CALL_LIMIT) return undefined;
  const window = rows.slice(-REPEAT_WINDOW);

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
        // Restate the previous failure instead of only naming the code: knowing it is
        // "the same error" is not actionable, knowing what it said last time is.
        const previous = faults[faults.length > 1 ? faults.length - 2 : 0];
        const detail = previous ? failureDetail(previous) : undefined;
        const recap = detail ? `上一次同样失败时错误写的是：${detail}。` : "";
        return `${RULE_MARKERS.fault} runtime: 最近 ${window.length} 次调用中已第 ${faults.length} 次收到同一个错误（faultCode=${currentFault}）。${recap}先确认上一次是否已生效；要继续就改参数或换方法，不要原样重放——同参重放已连续失败 ${faults.length} 次。若上面写的处置方向指向环境或服务侧（例如扩展构建、桥接、服务版本），重复调用同一个工具不会变好，改走宿主侧探针或直接向用户说明卡点。`;
      }
    }
  }
  return undefined;
}
