import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameType, encodeCredit, encodeFrame } from "../../shared/stream-frame.ts";
import { createStreamHub } from "../stream/pipe.ts";
import { runStreamTool } from "./stream-tools.ts";
import type { BrowserHost } from "../types.ts";

const temp = () => mkdtempSync(join(tmpdir(), "tchrome-stream-tool-"));

test("stream.pull writes browser bytes through the pipe and stream.push uploads a host file", async () => {
  const dir = temp();
  try {
    const hub = createStreamHub();
    const sent: ArrayBuffer[] = [];
    hub.attach((frame) => sent.push(frame));
    const host: BrowserHost = {
      readOpenTabs: async () => ({ ok: true, windows: [] }),
      execute: async (name, input) => {
        if (name === "stream.capture") {
          const streamId = Number(input.streamId);
          hub.handleMessage(encodeFrame(FrameType.data, streamId, 0, new TextEncoder().encode("hello")));
          hub.handleMessage(encodeFrame(FrameType.end, streamId, 1));
          return { ok: true, bytes: 5 };
        }
        if (name === "stream.receive") {
          const streamId = Number(input.streamId);
          hub.handleMessage(encodeCredit(streamId, 256 * 1024));
          return { ok: true, status: 201, bytes: 3 };
        }
        return { ok: false, error: "unexpected" };
      },
    };
    // patch getStreamHub by exercising createStreamHub directly via runStreamTool is coupled to singleton;
    // use the singleton after ensuring it has the same attach.
    const { getStreamHub } = await import("../stream/pipe.ts");
    const shared = getStreamHub();
    shared.attach((frame) => sent.push(frame));
    const sharedHost: BrowserHost = {
      ...host,
      execute: async (name, input) => {
        if (name === "stream.capture") {
          const streamId = Number(input.streamId);
          shared.handleMessage(encodeFrame(FrameType.data, streamId, 0, new TextEncoder().encode("hello")));
          shared.handleMessage(encodeFrame(FrameType.end, streamId, 1));
          return { ok: true, bytes: 5 };
        }
        if (name === "stream.receive") {
          shared.handleMessage(encodeCredit(Number(input.streamId), 256 * 1024));
          return { ok: true, status: 201 };
        }
        return { ok: false, error: "unexpected" };
      },
    };
    const dest = join(dir, "pulled.txt");
    const pull = await runStreamTool("stream.pull", {
      source: { kind: "http", url: "https://example.com/a" },
      path: dest,
    }, sharedHost, dir, "cv_01");
    expect(pull).toMatchObject({ ok: true, path: dest, bytes: 5 });
    expect(readFileSync(dest, "utf8")).toBe("hello");

    const source = join(dir, "push.bin");
    writeFileSync(source, "abc");
    const push = await runStreamTool("stream.push", {
      path: source,
      target: { kind: "http", url: "https://example.com/upload" },
    }, sharedHost, dir, "cv_01");
    expect(push).toMatchObject({ ok: true, bytes: 3, status: 201 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stream tools require absolute host path and a browser bridge", async () => {
  await expect(runStreamTool("stream.pull", { source: { kind: "dom" }, path: "relative" }, { readOpenTabs: async () => ({ ok: true, windows: [] }), execute: async () => ({ ok: true }) }))
    .resolves.toMatchObject({ ok: false });
  await expect(runStreamTool("stream.pull", { source: { kind: "dom" }, path: "/tmp/x" }, undefined))
    .resolves.toMatchObject({ ok: false });
});
