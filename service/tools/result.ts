import { errorInfo, errorMessage, errorRecovery, modelSpeech, type Recovery } from "../../shared/errors.ts";
import type { ToolExecution } from "./effects.ts";

/** Keep domain fields while exposing one model-facing failure contract. */
export type ToolFailure = Record<string, unknown> & {
  ok: false; faultCode: string; message: string; recovery: Recovery; details: Record<string, unknown>;
};

export function toolFailure(value: Record<string, unknown>, fallback = "tool_execution_failed"): ToolFailure {
  const { error, detail, message: _message, recovery: _recovery, details, ...fields } = value;
  const faultCode = typeof value.faultCode === "string" && value.faultCode ? value.faultCode
    : value.status === "cancelled" ? "stopped"
    : typeof value.status === "number" && value.status >= 400 ? "http_error" : fallback;
  const reasonRaw = typeof detail === "string" && detail ? detail : typeof error === "string" ? error : undefined;
  const reason = reasonRaw ? modelSpeech(reasonRaw) : undefined;
  const extra = details && typeof details === "object" && !Array.isArray(details)
    ? Object.fromEntries(Object.entries(details).map(([key, value]) => [key, typeof value === "string" ? modelSpeech(value) : value]))
    : {};
  return {
    ...fields, ok: false, faultCode,
    message: errorMessage(faultCode, "model"), recovery: errorRecovery(faultCode),
    details: { ...extra, ...(reason ? { reason } : {}) },
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
