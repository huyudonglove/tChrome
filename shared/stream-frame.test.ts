import { expect, test } from "bun:test";
import { FRAME_HEADER, FrameType, creditOf, decodeFrame, encodeCredit, encodeFrame } from "./stream-frame.ts";

test("stream frames round-trip data, end, error and credit", () => {
  const payload = new Uint8Array([1, 2, 3, 250]);
  const data = decodeFrame(encodeFrame(FrameType.data, 12, 3, payload));
  expect(data).toEqual({ type: FrameType.data, streamId: 12, seq: 3, payload });
  const end = decodeFrame(encodeFrame(FrameType.end, 12, 4));
  expect(end.type).toBe(FrameType.end);
  expect(end.payload.byteLength).toBe(0);
  const err = decodeFrame(encodeFrame(FrameType.error, 7, 0, new TextEncoder().encode("boom")));
  expect(new TextDecoder().decode(err.payload)).toBe("boom");
  const credit = decodeFrame(encodeCredit(9, 4096));
  expect(credit.type).toBe(FrameType.credit);
  expect(creditOf(credit.payload)).toBe(4096);
  expect(FRAME_HEADER).toBe(12);
  expect(() => decodeFrame(new Uint8Array(4))).toThrow();
  expect(() => decodeFrame(encodeFrame(FrameType.data, 1, 0, payload).slice(0, FRAME_HEADER + 2))).toThrow("truncated");
});
