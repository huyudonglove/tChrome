import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolBridge } from "./bridge.ts";

const roots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), "tchrome-bridge-")); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("bridge exposes concurrent requests and resolves any of them by id", async () => {
  const dir = root();
  const bridge = createToolBridge(dir);
  try {
    const first = bridge.execute("first", {});
    const second = bridge.execute("second", {});
    const listed = bridge.list();
    expect(listed.map((row) => row.name)).toEqual(["first", "second"]);
    expect(listed[0]!.id).toBe("br_01");
    expect(bridge.resolve("unknown", { ok: true })).toBe(false);
    // Out-of-order completion is allowed.
    expect(bridge.resolve(listed[1]!.id, { ok: true, text: "second" })).toBe(true);
    expect(await second).toEqual({ ok: true, text: "second" });
    expect(bridge.list().map((row) => row.name)).toEqual(["first"]);
    expect(bridge.resolve(listed[0]!.id, { ok: true, text: "first" })).toBe(true);
    expect(await first).toEqual({ ok: true, text: "first" });
    expect(bridge.list()).toEqual([]);
    const restarted = createToolBridge(dir);
    const pending = restarted.execute("after-restart", {});
    expect(restarted.list()[0]!.id).toBe("br_03");
    restarted.abort();
    await pending;
  } finally { bridge.abort(); }
});

test("scoped abort removes only its conversation and leaves the rest", async () => {
  const dir = root();
  const bridge = createToolBridge(dir);
  const a = bridge.forScope!("cv_a");
  const b = bridge.forScope!("cv_b");
  const a1 = a.execute("a1", {});
  const b1 = b.execute("b1", {});
  const a2 = a.execute("a2", {});
  bridge.abort("cv_a");
  expect(await a1).toEqual({ ok: false, faultCode: "stopped", error: "已停止" });
  expect(await a2).toEqual({ ok: false, faultCode: "stopped", error: "已停止" });
  expect(bridge.list().map((row) => row.name)).toEqual(["b1"]);
  bridge.resolve(bridge.list()[0]!.id, { ok: true });
  expect(await b1).toEqual({ ok: true });
  const final = b.execute("final", {});
  b.abort!();
  expect(await final).toEqual({ ok: false, faultCode: "stopped", error: "已停止" });
  expect(bridge.list()).toEqual([]);
});

test("global abort drains all pending requests and ignores late results", async () => {
  const bridge = createToolBridge(root());
  const first = bridge.execute("first", {});
  const id = bridge.list()[0]!.id;
  const second = bridge.execute("second", {});
  bridge.abort();
  expect(await first).toEqual({ ok: false, faultCode: "stopped", error: "已停止" });
  expect(await second).toEqual({ ok: false, faultCode: "stopped", error: "已停止" });
  expect(bridge.list()).toEqual([]);
  expect(bridge.resolve(id, { ok: true })).toBe(false);
});

test("executeTracked exposes the request id and abortById removes only that pending call", async () => {
  const bridge = createToolBridge(root());
  const tracked = bridge.executeTracked!("script", {});
  expect(tracked.id).toBe("br_01");
  const other = bridge.execute("other", {});
  expect(bridge.abortById(tracked.id)).toBe(true);
  expect(await tracked.result).toEqual({ ok: false, faultCode: "stopped", error: "已停止" });
  expect(bridge.list().map((row) => row.name)).toEqual(["other"]);
  expect(bridge.abortById(tracked.id)).toBe(false);
  bridge.resolve(bridge.list()[0]!.id, { ok: true });
  expect(await other).toEqual({ ok: true });
});
