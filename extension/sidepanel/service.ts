import { AppError, errorMessage } from "../../shared/errors.ts";

export const SERVICE = "http://127.0.0.1:18788";
export const DOWN = errorMessage("service_unreachable", "user");

// Control requests must settle so a failed refresh cannot hold the send lock.
// A turn can legitimately outlive the control-request timeout.
export async function requestJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const caller = init?.signal;
  const timeout = path === "/turn" ? undefined : AbortSignal.timeout(15_000);
  const signal = caller && timeout ? AbortSignal.any([caller, timeout]) : caller ?? timeout;
  const transportError = (cause: unknown): AppError => {
    const name = cause instanceof Error ? cause.name : undefined;
    const code = caller?.aborted ? "service_cancelled"
      : timeout?.aborted || name === "TimeoutError" ? "service_timeout"
      : name === "AbortError" ? "service_cancelled" : "service_unreachable";
    return new AppError(code, errorMessage(code, "user"), { path }, { cause });
  };
  let response: Response;
  let text: string;
  try {
    signal?.throwIfAborted();
    response = await fetch(`${SERVICE}${path}`, { ...init, signal });
    text = await response.text();
    signal?.throwIfAborted();
  } catch (cause) {
    throw transportError(cause);
  }
  let body: any;
  try { body = JSON.parse(text); } catch { body = undefined; }
  if (!response.ok) {
    throw new AppError("service_http_error", errorMessage("service_http_error", "user"), {
      path, status: response.status, body: body ?? text,
    });
  }
  if (body === undefined || body === null) {
    throw new AppError("service_invalid_response", errorMessage("service_invalid_response", "user"), { path });
  }
  if (["/session", "/stop", "/conversations/open", "/conversations/new", "/conversations/delete"].includes(path)
    && (typeof body !== "object" || !Array.isArray(body.messages)
      || !["idle", "running", "waiting_human", "paused", "failed"].includes(body.status)
      || !(body.conversationId === null || typeof body.conversationId === "string"))) {
    throw new AppError("service_invalid_response", errorMessage("service_invalid_response", "user"), { path });
  }
  return body as T;
}

export const errorText = (error: unknown) => error instanceof Error ? error.message : "请求失败";
