import messages from "./error-messages.json";

export type Recovery = "correct_arguments" | "inspect_state" | "user_action" | "retry" | "none";
type ErrorMessage = { model: string; user: string; recovery: Recovery };
const catalog = messages as Record<string, ErrorMessage>;

export class AppError extends Error {
  constructor(readonly faultCode: string, message: string, readonly details?: Record<string, unknown>, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppError";
  }
}

export type ErrorInfo = { faultCode: string; detail: string; details?: Record<string, unknown> };

const nodeCodes: Record<string, string> = {
  ENOENT: "file_not_found", EACCES: "permission_denied", EPERM: "permission_denied",
  ENOTDIR: "invalid_path", EEXIST: "file_exists",
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Retain diagnostic detail without inferring recovery from arbitrary error text. */
export function errorInfo(error: unknown, fallback = "tool_execution_failed"): ErrorInfo {
  const source = record(error) ? error : {};
  const faultCode = nonempty(source.faultCode) ? source.faultCode
    : source.name === "AbortError" ? "stopped"
    : source.name === "HttpIdleTimeoutError" ? "http_idle_timeout"
    : typeof source.code === "string" && Object.hasOwn(nodeCodes, source.code) ? nodeCodes[source.code]!
    : fallback;
  const detail = [source.detail, source.message, source.error, error].find(nonempty) ?? errorMessage(faultCode, "model");
  return { faultCode, detail, ...(record(source.details) ? { details: source.details } : {}) };
}

const messageFor = (code: string): ErrorMessage =>
  Object.hasOwn(catalog, code) ? catalog[code]! : catalog.tool_execution_failed!;

export function errorMessage(code: string, audience: "model" | "user"): string {
  return messageFor(code)[audience];
}

/** Recovery advice for the model, distinct from transport retry policy. */
export function errorRecovery(code: string): Recovery {
  return messageFor(code).recovery;
}
