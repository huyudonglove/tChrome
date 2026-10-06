import { errorInfo, errorMessage, errorRecovery } from "../../shared/errors.ts";
import type { ToolExecution } from "./effects.ts";

/** Keep domain fields while exposing one model-facing failure contract. */
export type ToolFailure = Record<string, unknown> & {
  ok: false; faultCode: string; message: unknown; recovery: unknown; details: unknown;
};

export function toolFailure(value: Record<string, unknown>, fallback = "tool_execution_failed"): ToolFailure {
  const { error, detail, message, details } = value;
  const faultCode = typeof value.faultCode === "string" && value.faultCode ? value.faultCode
    : value.status === "cancelled" ? "stopped"
    : typeof value.status === "number" && value.status >= 400 ? "http_error" : fallback;
  const reason = [detail, error, message].find((item) => typeof item === "string" && item.length > 0);
  const extra = details && typeof details === "object" && !Array.isArray(details) ? details : undefined;
  return {
    ...value, ok: false, faultCode,
    message: message === undefined ? errorMessage(faultCode, "model") : message,
    recovery: value.recovery === undefined ? errorRecovery(faultCode) : value.recovery,
    details: extra || details === undefined ? { ...(reason ? { reason } : {}), ...extra } : details,
  };
}

export function failedTool(error: unknown, fallback = "tool_execution_failed", fields: Record<string, unknown> = {}): ToolExecution {
  const info = errorInfo(error, fallback);
  return { text: JSON.stringify(toolFailure({ ...fields, ...info })), effects: [] };
}

export function normalizeToolExecution(execution: ToolExecution, toolName?: string): ToolExecution {
  let value: unknown;
  try { value = JSON.parse(execution.text); } catch { return execution; }
  const normalize = (item: unknown): unknown => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    let fields = item as Record<string, unknown>;
    if (toolName === "send_http_batch" && Array.isArray(fields.results)) fields = { ...fields, results: fields.results.map(normalize) };
    return fields.ok === false || fields.status === "error" || fields.status === "cancelled"
      || (fields.ok === undefined && typeof fields.error === "string") ? toolFailure({ ...(toolName ? { toolName } : {}), ...fields }) : fields;
  };
  return { ...execution, text: JSON.stringify(normalize(value)) };
}
