import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolBridge } from "./bridge.ts";

const roots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), "tchrome-bridge-")); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("bridge exposes FIFO requests and rejects results for queued or completed requests", async () => {
  const dir = root();
  const bridge = createToolBridge(dir);
  try {
    const first = bridge.execute("first", {});
    const firstId = bridge.current()!.id;
    expect(firstId).toBe("br_01");
    const second = bridge.execute("second", {});
    expect(bridge.current()!.id).toBe(firstId);
    expect(bridge.resolve("unknown", { ok: true })).toBe(false);
    bridge.resolve(firstId, { ok: true });
    expect(await first).toEqual({ ok: true });
    expect(bridge.current()!.name).toBe("second");
    expect(bridge.resolve(firstId, { ok: true })).toBe(false);
    bridge.resolve(bridge.current()!.id, { ok: true });
    expect(await second).toEqual({ ok: true });
    expect(bridge.current()).toBeNull();
    const restarted = createToolBridge(dir);
    const pending = restarted.execute("after-restart", {});
    expect(restarted.current()!.id).toBe("br_03");
    restarted.abort();
    await pending;
  } finally { bridge.abort(); }
});

test("scoped abort removes only its conversation and promotes the next request", async () => {
  const bridge = createToolBridge(root());
  const a = bridge.forScope!("cv_a");
  const b = bridge.forScope!("cv_b");
  const a1 = a.execute("a1", {});
  const b1 = b.execute("b1", {});
  const a2 = a.execute("a2", {});
  bridge.abort("cv_a");
  expect(await a1).toEqual({ ok: false, faultCode: "stopped", error: "已停止" });
  expect(await a2).toEqual({ ok: false, faultCode: "stopped", error: "已停止" });
  expect(bridge.current()!.name).toBe("b1");
  bridge.resolve(bridge.current()!.id, { ok: true });
  expect(await b1).toEqual({ ok: true });
  const final = b.execute("final", {});
  b.abort!();
  expect(await final).toEqual({ ok: false, faultCode: "stopped", error: "已停止" });
  expect(bridge.current()).toBeNull();
});

test("global abort drains current and waiting requests and ignores late results", async () => {
  const bridge = createToolBridge(root());
  const first = bridge.execute("first", {});
  const id = bridge.current()!.id;
  const second = bridge.execute("second", {});
  bridge.abort();
  expect(await first).toEqual({ ok: false, faultCode: "stopped", error: "已停止" });
  expect(await second).toEqual({ ok: false, faultCode: "stopped", error: "已停止" });
  expect(bridge.current()).toBeNull();
  expect(bridge.resolve(id, { ok: true })).toBe(false);
});
