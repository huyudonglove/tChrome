import type { ToolIOItem } from "../types.ts";

/** Consecutive identical calls before a hint is emitted (hint only, never blocks). */
export const REPEAT_CALL_LIMIT = 2;
/** Consecutive identical failures before a hint is emitted. */
export const REPEAT_FAULT_LIMIT = 2;

/** Stable stringify so key order never makes two identical calls look different. */
function fingerprint(args: unknown): string {
  if (args === null || typeof args !== "object") return JSON.stringify(args ?? null) ?? "null";
  if (Array.isArray(args)) return `[${args.map(fingerprint).join(",")}]`;
  const entries = Object.entries(args as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${JSON.stringify(key)}:${fingerprint(value)}`);
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

/**
 * High-precision repeat detection, hint only:
 * 1. the same tool called twice in a row with identical arguments;
 * 2. two consecutive rows failing with the same faultCode + message.
 * Deliberately not a per-tool frequency counter: broad frequency rules misfire
 * (e.g. many `local.fs_read` calls in one turn) and cannot see looping attempts.
 */
export function repeatHint(rows: ToolIOItem[]): string | undefined {
  if (rows.length < REPEAT_CALL_LIMIT) return undefined;
  const current = rows[rows.length - 1]!;
  const previous = rows[rows.length - 2]!;

  if (current.name === previous.name && fingerprint(current.arguments) === fingerprint(previous.arguments)) {
    return `runtime: 连续第 ${REPEAT_CALL_LIMIT} 次以完全相同参数调用 ${current.name}。先确认上一次是否已生效；若需换路径就改参数或方案，不要原样重放。`;
  }

  const currentFault = failureSignature(current);
  if (currentFault && currentFault === failureSignature(previous)) {
    const [faultCode] = currentFault.split("::");
    return `runtime: 连续第 ${REPEAT_FAULT_LIMIT} 次收到同一个错误（faultCode=${faultCode}）。先读错误里的 details/recovery 改参数或换方法，不要继续用同样的调用。`;
  }
  return undefined;
}
