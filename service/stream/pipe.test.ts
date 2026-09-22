import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameType, encodeCredit, encodeFrame } from "../../shared/stream-frame.ts";
import { createStreamHub } from "./pipe.ts";

const temp = () => mkdtempSync(join(tmpdir(), "tchrome-stream-"));

test("pull assembles frames into a host file and writes credit", async () => {
  const dir = temp();
  try {
    const hub = createStreamHub();
    const sent: ArrayBuffer[] = [];
    hub.attach((frame) => sent.push(frame));
    const dest = join(dir, "out.bin");
    const pull = hub.openPull(3, dest);
    hub.handleMessage(encodeFrame(FrameType.data, 3, 0, new Uint8Array([1, 2])));
    hub.handleMessage(encodeFrame(FrameType.data, 3, 1, new Uint8Array([3])));
    hub.handleMessage(encodeFrame(FrameType.end, 3, 2));
    const result = await pull;
    expect(result).toMatchObject({ ok: true, streamId: 3, path: dest, bytes: 3 });
    expect(readFileSync(dest)).toEqual(Buffer.from([1, 2, 3]));
    expect(existsSync(`${dest}.tchrome-stream`)).toBe(false);
    expect(sent.some((frame) => new DataView(frame).getUint8(3) === FrameType.credit)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pull surfaces remote error and push sends file after credit", async () => {
  const dir = temp();
  try {
    const hub = createStreamHub();
    const sent: ArrayBuffer[] = [];
    hub.attach((frame) => sent.push(frame));
    const failed = hub.openPull(4, join(dir, "err.bin"));
    hub.handleMessage(encodeFrame(FrameType.error, 4, 0, new TextEncoder().encode("remote failed")));
    await expect(failed).resolves.toMatchObject({ ok: false, error: "remote failed" });

    const source = join(dir, "src.bin");
    writeFileSync(source, Buffer.alloc(70_000, 7));
    hub.openPush(8);
    const push = hub.pushFile(8, source);
    hub.handleMessage(encodeCredit(8, 256 * 1024));
    const pushed = await push;
    expect(pushed).toMatchObject({ ok: true, streamId: 8, bytes: 70_000 });
    const dataFrames = sent.filter((frame) => new DataView(frame).getUint8(3) === FrameType.data);
    expect(dataFrames.length).toBeGreaterThan(1);
    const endFrame = sent.find((frame) => new DataView(frame).getUint8(3) === FrameType.end);
    expect(endFrame).toBeTruthy();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
