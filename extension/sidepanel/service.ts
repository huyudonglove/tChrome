import { fetchWithIdleTimeout } from "../../service/network/idle-fetch.ts";
import { AppError, errorMessage } from "../../shared/errors.ts";

export const SERVICE = "http://127.0.0.1:18788";
export const DOWN = errorMessage("service_unreachable", "user");

// Control requests share the network inactivity deadline; turns wait for completion.
export async function requestJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const caller = init?.signal;

  const transportError = (cause: unknown): AppError => {
    const name = cause instanceof Error ? cause.name : undefined;
    const code = caller?.aborted ? "service_cancelled"
      : name === "HttpIdleTimeoutError" || name === "TimeoutError" ? "service_timeout"
      : name === "AbortError" ? "service_cancelled" : "service_unreachable";
    return new AppError(code, errorMessage(code, "user"), { path }, { cause });
  };
  let response: Response;
  let text: string;
  try {
    caller?.throwIfAborted();
    response = await (path === "/turn" ? fetch : fetchWithIdleTimeout)(`${SERVICE}${path}`, init);
    text = await response.text();
    caller?.throwIfAborted();
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
