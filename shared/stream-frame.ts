/** Host-Browser Stream Pipe binary frames. Header 12 bytes + payload. */
export const STREAM_MAGIC = 0x5350;
export const STREAM_VERSION = 1;
export const FRAME_HEADER = 12;
export const CHUNK_BYTES = 32 * 1024;
export const WINDOW_BYTES = 256 * 1024;

export const FrameType = {
  data: 1,
  end: 2,
  error: 3,
  credit: 4,
} as const;
export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

export type Frame = {
  type: FrameTypeValue;
  streamId: number;
  seq: number;
  payload: Uint8Array;
};

export function encodeFrame(type: FrameTypeValue, streamId: number, seq: number, payload: Uint8Array = new Uint8Array(0)): ArrayBuffer {
  const buf = new ArrayBuffer(FRAME_HEADER + payload.byteLength);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  view.setUint16(0, STREAM_MAGIC, true);
  view.setUint8(2, STREAM_VERSION);
  view.setUint8(3, type);
  view.setUint16(4, streamId, true);
  view.setUint32(6, seq, true);
  view.setUint16(10, payload.byteLength, true);
  bytes.set(payload, FRAME_HEADER);
  return buf;
}

export function encodeCredit(streamId: number, bytes: number): ArrayBuffer {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, bytes >>> 0, true);
  return encodeFrame(FrameType.credit, streamId, 0, payload);
}

export function decodeFrame(input: ArrayBuffer | Uint8Array): Frame {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < FRAME_HEADER) throw new Error("stream frame too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== STREAM_MAGIC) throw new Error("stream frame bad magic");
  if (view.getUint8(2) !== STREAM_VERSION) throw new Error("stream frame bad version");
  const type = view.getUint8(3) as FrameTypeValue;
  const streamId = view.getUint16(4, true);
  const seq = view.getUint32(6, true);
  const length = view.getUint16(10, true);
  if (bytes.byteLength < FRAME_HEADER + length) throw new Error("stream frame truncated");
  return { type, streamId, seq, payload: bytes.subarray(FRAME_HEADER, FRAME_HEADER + length) };
}

export function creditOf(payload: Uint8Array): number {
  if (payload.byteLength < 4) return 0;
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true);
}
