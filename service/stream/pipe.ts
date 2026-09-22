import { createWriteStream, createReadStream, statSync, mkdirSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { open, type FileHandle } from "node:fs/promises";
import {
  CHUNK_BYTES,
  FRAME_HEADER,
  FrameType,
  WINDOW_BYTES,
  creditOf,
  decodeFrame,
  encodeCredit,
  encodeFrame,
  type FrameTypeValue,
} from "../../shared/stream-frame.ts";

type PullSession = {
  direction: "pull";
  streamId: number;
  path: string;
  tempPath: string;
  handle: FileHandle | null;
  bytes: number;
  seq: number;
  writeChain: Promise<void>;
  settle: (result: PullResult) => void;
  result: Promise<PullResult>;
};

type PushSession = {
  direction: "push";
  streamId: number;
  credit: number;
  seq: number;
  settled: boolean;
};

export type PullResult = { ok: true; streamId: number; path: string; bytes: number } | { ok: false; streamId: number; error: string };
export type PushResult = { ok: true; streamId: number; bytes: number } | { ok: false; streamId: number; error: string };

export type StreamHub = {
  attach(send: (data: ArrayBuffer) => void): void;
  detach(send: (data: ArrayBuffer) => void): void;
  handleMessage(data: ArrayBuffer | Uint8Array): void;
  openPull(streamId: number, path: string): Promise<PullResult>;
  pushFile(streamId: number, path: string): Promise<PushResult>;
  openPush(streamId: number): void;
  abort(streamId: number, error: string): void;
};

const absoluteFile = (path: unknown): string => {
  if (typeof path !== "string" || !path.trim()) throw new Error("path 必须是绝对路径");
  const value = resolve(path.trim());
  if (!value.startsWith("/")) throw new Error("path 必须是绝对路径");
  return value;
};

export function createStreamHub(): StreamHub {
  const pulls = new Map<number, PullSession>();
  const pushes = new Map<number, PushSession>();
  const senders = new Set<(data: ArrayBuffer) => void>();

  const send = (data: ArrayBuffer) => {
    for (const sender of senders) sender(data);
  };

  const settlePull = (session: PullSession, result: PullResult) => {
    void session.handle?.close();
    if (result.ok) {
      try { renameSync(session.tempPath, session.path); } catch { /* keep temp if rename fails */ }
    } else {
      try { unlinkSync(session.tempPath); } catch { /* ignore */ }
    }
    pulls.delete(session.streamId);
    session.settle(result);
  };

  const abort = (streamId: number, error: string) => {
    const pull = pulls.get(streamId);
    if (pull) settlePull(pull, { ok: false, streamId, error });
    const push = pushes.get(streamId);
    if (push) {
      pushes.delete(streamId);
      void push;
    }
  };

  const openPull = (streamId: number, path: string): Promise<PullResult> => {
    if (pulls.has(streamId) || pushes.has(streamId)) throw new Error(`stream ${streamId} 已存在`);
    const target = absoluteFile(path);
    mkdirSync(dirname(target), { recursive: true });
    const tempPath = `${target}.tchrome-stream`;
    let settle!: (result: PullResult) => void;
    const result = new Promise<PullResult>((done) => { settle = done; });
    const session: PullSession = {
      direction: "pull", streamId, path: target, tempPath, handle: null, bytes: 0, seq: 0,
      writeChain: Promise.resolve(), settle, result,
    };
    pulls.set(streamId, session);
    session.writeChain = open(tempPath, "w").then((handle) => {
      if (!pulls.has(streamId)) { void handle.close(); return; }
      session.handle = handle;
      send(encodeCredit(streamId, WINDOW_BYTES));
    }, (error) => settlePull(session, { ok: false, streamId, error: error instanceof Error ? error.message : String(error) }));
    return result;
  };

  const openPush = (streamId: number) => {
    if (pulls.has(streamId) || pushes.has(streamId)) throw new Error(`stream ${streamId} 已存在`);
    pushes.set(streamId, { direction: "push", streamId, credit: 0, seq: 0, settled: false });
  };

  const pushFile = async (streamId: number, path: string): Promise<PushResult> => {
    const source = absoluteFile(path);
    const session = pushes.get(streamId);
    if (!session) {
      openPush(streamId);
      return pushFile(streamId, source);
    }
    try {
      const stat = statSync(source);
      if (!stat.isFile()) return { ok: false, streamId, error: "path 不是普通文件" };
      const handle = await open(source, "r");
      try {
        let sent = 0;
        while (sent < stat.size) {
          while (session.credit <= 0 && pushes.has(streamId)) await new Promise((r) => setTimeout(r, 4));
          if (!pushes.has(streamId)) return { ok: false, streamId, error: "stream 已中止" };
          const want = Math.min(CHUNK_BYTES, session.credit, stat.size - sent);
          const chunk = Buffer.alloc(want);
          const { bytesRead } = await handle.read(chunk, 0, want, sent);
          if (bytesRead <= 0) break;
          const payload = new Uint8Array(chunk.subarray(0, bytesRead));
          session.credit -= bytesRead;
          send(encodeFrame(FrameType.data, streamId, session.seq++, payload));
          sent += bytesRead;
        }
        send(encodeFrame(FrameType.end, streamId, session.seq++, new Uint8Array(0)));
        pushes.delete(streamId);
        return { ok: true, streamId, bytes: sent };
      } finally {
        await handle.close();
      }
    } catch (error) {
      pushes.delete(streamId);
      const message = error instanceof Error ? error.message : String(error);
      send(encodeFrame(FrameType.error, streamId, 0, new TextEncoder().encode(message)));
      return { ok: false, streamId, error: message };
    }
  };

  const handleMessage = (data: ArrayBuffer | Uint8Array) => {
    let frame;
    try { frame = decodeFrame(data); }
    catch { return; }
    if (frame.type === FrameType.credit) {
      const push = pushes.get(frame.streamId);
      if (push) push.credit += creditOf(frame.payload);
      return;
    }
    const pull = pulls.get(frame.streamId);
    if (!pull) return;
    if (frame.type === FrameType.data) {
      const payload = Uint8Array.from(frame.payload);
      pull.writeChain = pull.writeChain.then(async () => {
        if (!pulls.has(frame.streamId)) return;
        try {
          if (!pull.handle) pull.handle = await open(pull.tempPath, "a");
          await pull.handle.write(Buffer.from(payload));
          pull.bytes += payload.byteLength;
          send(encodeCredit(frame.streamId, Math.max(payload.byteLength, 1)));
        } catch (error) {
          settlePull(pull, { ok: false, streamId: frame.streamId, error: error instanceof Error ? error.message : String(error) });
        }
      });
      return;
    }
    if (frame.type === FrameType.end) {
      void pull.writeChain.then(() => {
        if (pulls.has(frame.streamId)) settlePull(pull, { ok: true, streamId: frame.streamId, path: pull.path, bytes: pull.bytes });
      });
      return;
    }
    if (frame.type === FrameType.error) {
      settlePull(pull, { ok: false, streamId: frame.streamId, error: new TextDecoder().decode(frame.payload) || "stream error" });
    }
  };

  return {
    attach(fn) { senders.add(fn); },
    detach(fn) { senders.delete(fn); },
    handleMessage,
    openPull,
    openPush,
    pushFile,
    abort,
  };
}

let sharedHub: StreamHub | null = null;
export function getStreamHub(): StreamHub {
  return (sharedHub ??= createStreamHub());
}

export const STREAM_FRAME_SIZE = FRAME_HEADER;
export type { FrameTypeValue };
export { createReadStream, existsSync };
