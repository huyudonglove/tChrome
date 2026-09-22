import { appendAsset } from "../assets/catalog.ts";
import { getStreamHub } from "../stream/pipe.ts";
import type { BrowserHost } from "../types.ts";

export const STREAM_TOOL_NAMES = ["stream.pull", "stream.push"] as const;

let nextStreamId = 1;
const allocateStreamId = () => (nextStreamId = (nextStreamId % 0xffff) || 1);

const absPath = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  const path = value.trim();
  return path.startsWith("/") ? path : null;
};

export async function runStreamTool(
  name: string,
  input: Record<string, unknown>,
  host: BrowserHost | undefined,
  dataDir: string,
  conversationId: string | undefined,
): Promise<Record<string, unknown>> {
  if (!host) return { ok: false, error: "stream 需要浏览器桥" };
  if (!conversationId) return { ok: false, error: "stream 工具缺少会话标识" };
  const hub = getStreamHub();
  const streamId = allocateStreamId();
  try {
    if (name === "stream.pull") {
      const path = absPath(input.path);
      if (!path) return { ok: false, error: "path 必须是宿主绝对路径" };
      const source = input.source;
      if (!source || typeof source !== "object") return { ok: false, error: "缺 source" };
      const pullPromise = hub.openPull(streamId, path);
      const capture = await host.execute("stream.capture", { streamId, source });
      const streamed = await pullPromise;
      if (!streamed.ok) return { ok: false, streamId, error: streamed.error };
      if (capture && capture.ok === false) return { ok: false, streamId, error: String((capture as { error?: unknown }).error ?? "stream.capture failed") };
      appendAsset(dataDir, conversationId, {
        name: path.split("/").pop() || `stream-${streamId}`,
        kind: "binary",
        bytes: streamed.bytes,
        summary: `stream.pull ${(source as { kind?: string }).kind ?? "data"} · ${streamed.bytes}B`,
        source: { tool: "stream.pull", ...(typeof (source as { url?: string }).url === "string" ? { url: (source as { url?: string }).url } : {}) },
        path,
      });
      return { ok: true, streamId, path: streamed.path, bytes: streamed.bytes };
    }
    const path = absPath(input.path);
    if (!path) return { ok: false, error: "path 必须是宿主绝对路径" };
    const target = input.target;
    if (!target || typeof target !== "object") return { ok: false, error: "缺 target" };
    hub.openPush(streamId);
    const receive = host.execute("stream.receive", { streamId, target });
    const pushed = await hub.pushFile(streamId, path);
    const result = await receive;
    if (!pushed.ok) return { ok: false, streamId, error: pushed.error };
    appendAsset(dataDir, conversationId, {
      name: path.split("/").pop() || `push-${streamId}`,
      kind: "binary",
      bytes: pushed.bytes,
      summary: `stream.push ${pushed.bytes}B`,
      source: { tool: "stream.push" },
      path,
    });
    return { ok: true, streamId, bytes: pushed.bytes, ...(result && typeof result === "object" ? result as Record<string, unknown> : {}) };
  } catch (error) {
    hub.abort(streamId, error instanceof Error ? error.message : String(error));
    return { ok: false, streamId, error: error instanceof Error ? error.message : String(error) };
  }
}
