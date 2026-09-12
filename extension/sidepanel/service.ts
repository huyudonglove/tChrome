export const SERVICE = "http://127.0.0.1:18788";
export const DOWN = "本机服务没开。终端跑 bun run service。";

// Control requests must settle so a failed refresh cannot hold the send lock.
// A turn can legitimately outlive the control-request timeout.
export async function requestJSON<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${SERVICE}${path}`, {
      ...init,
      signal: init?.signal ?? (path === "/turn" ? undefined : AbortSignal.timeout(15_000)),
    });
  } catch {
    throw new Error(DOWN);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body?.error || body?.output?.faultCode;
    throw new Error(typeof detail === "string" ? `失败：${detail}` : `服务请求失败（HTTP ${response.status}）`);
  }
  if (body === null) throw new Error("服务返回了无效响应");
  if (["/session", "/stop", "/conversations/open", "/conversations/new", "/conversations/delete"].includes(path)
    && (typeof body !== "object" || !Array.isArray(body.messages)
      || !["idle", "running", "waiting_human", "paused", "failed"].includes(body.status)
      || !(body.conversationId === null || typeof body.conversationId === "string"))) {
    throw new Error("服务返回了无效的会话状态");
  }
  return body as T;
}

export const errorText = (error: unknown) => error instanceof Error ? error.message : "请求失败";
