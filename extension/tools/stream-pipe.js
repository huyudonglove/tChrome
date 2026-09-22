import {
  CHUNK_BYTES,
  FRAME_HEADER,
  FrameType,
  WINDOW_BYTES,
  creditOf,
  encodeCredit,
  encodeFrame,
} from "../../shared/stream-frame.ts";

const SERVICE_STREAM = "ws://127.0.0.1:18788/stream";

let socket = null;
let connecting = null;
const pullCredit = new Map();
const receiveBuffers = new Map();
const receiveWaiters = new Map();

const encode = (type, streamId, seq, payload = new Uint8Array(0)) => encodeFrame(type, streamId, seq, payload);

const ensureSocket = async () => {
  if (socket && socket.readyState === WebSocket.OPEN) return socket;
  if (connecting) return connecting;
  connecting = new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVICE_STREAM);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => { socket = ws; connecting = null; resolve(ws); };
    ws.onerror = () => { connecting = null; reject(new Error("stream pipe 连接失败")); };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      for (const [, waiters] of receiveWaiters) for (const waiter of waiters) waiter.reject?.(new Error("stream pipe 已断开"));
      receiveWaiters.clear();
    };
    ws.onmessage = (event) => {
      const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : null;
      if (!bytes || bytes.byteLength < FRAME_HEADER) return;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (view.getUint16(0, true) !== 0x5350) return;
      const type = view.getUint8(3);
      const streamId = view.getUint16(4, true);
      const length = view.getUint16(10, true);
      const payload = bytes.subarray(FRAME_HEADER, FRAME_HEADER + length);
      if (type === FrameType.credit) {
        pullCredit.set(streamId, (pullCredit.get(streamId) || 0) + creditOf(payload));
        return;
      }
      const buffer = receiveBuffers.get(streamId) || [];
      if (type === FrameType.data) {
        buffer.push(payload.slice());
        receiveBuffers.set(streamId, buffer);
        ws.send(encodeCredit(streamId, Math.max(payload.byteLength, 1)));
        return;
      }
      const waiters = receiveWaiters.get(streamId) || [];
      receiveWaiters.delete(streamId);
      if (type === FrameType.end) {
        for (const waiter of waiters) waiter.resolve({ ok: true, chunks: buffer });
        return;
      }
      const message = new TextDecoder().decode(payload) || "stream error";
      for (const waiter of waiters) waiter.resolve({ ok: false, error: message, chunks: buffer });
    };
  });
  return connecting;
};

const sendChunked = async (ws, streamId, data) => {
  pullCredit.set(streamId, WINDOW_BYTES);
  let offset = 0;
  let seq = 0;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  while (offset < bytes.byteLength) {
    while ((pullCredit.get(streamId) || 0) <= 0) await new Promise((r) => setTimeout(r, 4));
    const want = Math.min(CHUNK_BYTES, pullCredit.get(streamId), bytes.byteLength - offset);
    const chunk = bytes.subarray(offset, offset + want);
    ws.send(encode(FrameType.data, streamId, seq++, chunk));
    pullCredit.set(streamId, pullCredit.get(streamId) - want);
    offset += want;
  }
  ws.send(encode(FrameType.end, streamId, seq++, new Uint8Array(0)));
  return bytes.byteLength;
};

const captureHttp = async (source) => {
  const url = String(source.url || "");
  if (!/^https?:\/\//i.test(url)) return { error: "source.url 必须是 http(s) 链接" };
  const response = await fetch(url, {
    method: String(source.method || "GET"),
    headers: source.headers && typeof source.headers === "object" ? source.headers : undefined,
  });
  const body = new Uint8Array(await response.arrayBuffer());
  return { body, status: response.status };
};

const captureNetwork = async (source) => {
  const tabId = Number(source.tabId);
  const requestId = String(source.requestId || "");
  if (!Number.isFinite(tabId) || !requestId) return { error: "source.kind=network 需要 tabId 与 requestId" };
  await chrome.debugger.attach({ tabId }, "1.3");
  try {
    const result = await chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId });
    const raw = String(result?.body || "");
    const body = result?.base64Encoded ? Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)) : new TextEncoder().encode(raw);
    return { body, status: 200 };
  } finally {
    void chrome.debugger.detach({ tabId }).catch(() => {});
  }
};

const captureDom = async (source) => {
  const tabId = Number(source.tabId);
  if (!Number.isFinite(tabId)) return { error: "source.kind=dom 需要 tabId" };
  await chrome.debugger.attach({ tabId }, "1.3");
  try {
    const doc = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument", { depth: -1, pierce: true });
    const format = source.format === "json" ? "json" : "html";
    if (format === "json") {
      return { body: new TextEncoder().encode(JSON.stringify(doc)), status: 200 };
    }
    const html = await chrome.debugger.sendCommand({ tabId }, "DOM.getOuterHTML", { nodeId: doc?.root?.nodeId });
    return { body: new TextEncoder().encode(String(html?.outerHTML || "")), status: 200 };
  } finally {
    void chrome.debugger.detach({ tabId }).catch(() => {});
  }
};

export const streamCapture = async (input) => {
  const streamId = Number(input.streamId);
  const source = input.source || {};
  try {
    const ws = await ensureSocket();
    let captured;
    if (source.kind === "http") captured = await captureHttp(source);
    else if (source.kind === "network") captured = await captureNetwork(source);
    else if (source.kind === "dom") captured = await captureDom(source);
    else return { ok: false, error: "source.kind 需为 http|network|dom" };
    if (captured.error) {
      ws.send(encode(FrameType.error, streamId, 0, new TextEncoder().encode(captured.error)));
      return { ok: false, error: captured.error };
    }
    const bytes = await sendChunked(ws, streamId, captured.body);
    return { ok: true, bytes, status: captured.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      const ws = await ensureSocket();
      ws.send(encode(FrameType.error, streamId, 0, new TextEncoder().encode(message)));
    } catch { /* socket unavailable */ }
    return { ok: false, error: message };
  }
};

export const streamReceive = async (input) => {
  const streamId = Number(input.streamId);
  const target = input.target || {};
  if (target.kind !== "http") return { ok: false, error: "target.kind 需为 http" };
  const url = String(target.url || "");
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: "target.url 必须是 http(s) 链接" };
  const ws = await ensureSocket();
  const waiter = {};
  const promise = new Promise((resolve, reject) => {
    waiter.resolve = resolve;
    waiter.reject = reject;
  });
  const list = receiveWaiters.get(streamId) || [];
  list.push(waiter);
  receiveWaiters.set(streamId, list);
  ws.send(encodeCredit(streamId, WINDOW_BYTES));
  const streamed = await promise;
  if (!streamed.ok) return { ok: false, error: streamed.error };
  const body = concatChunks(streamed.chunks);
  const response = await fetch(url, {
    method: String(target.method || "POST"),
    headers: target.headers && typeof target.headers === "object" ? target.headers : undefined,
    body,
  });
  return { ok: response.ok, status: response.status, bytes: body.byteLength };
};

const concatChunks = (chunks) => {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};
