import { expect, test } from "bun:test";
import { createToolBridge } from "./bridge.ts";

test("bridge exposes FIFO requests and rejects results for queued or completed requests", async () => {
  const bridge = createToolBridge();
  try {
    const first = bridge.execute("first", {});
    const firstId = bridge.current()!.id;
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
  } finally { bridge.abort(); }
});

test("queued requests receive their full timeout only after activation", async () => {
  const bridge = createToolBridge(100);
  try {
    const first = bridge.execute("first", {});
    const second = bridge.execute("second", {});
    expect(await first).toEqual({ ok: false, faultCode: "tool_timeout", error: "浏览器工具超时" });
    expect(bridge.current()!.name).toBe("second");
    await Bun.sleep(25);
    expect(bridge.current()!.name).toBe("second");
    bridge.resolve(bridge.current()!.id, { ok: true });
    expect(await second).toEqual({ ok: true });
  } finally { bridge.abort(); }
});

test("scoped abort removes only its conversation and promotes the next request", async () => {
  const bridge = createToolBridge();
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
  const bridge = createToolBridge();
  const first = bridge.execute("first", {});
  const id = bridge.current()!.id;
  const second = bridge.execute("second", {});
  bridge.abort();
  expect(await first).toEqual({ ok: false, faultCode: "stopped", error: "已停止" });
  expect(await second).toEqual({ ok: false, faultCode: "stopped", error: "已停止" });
  expect(bridge.current()).toBeNull();
  expect(bridge.resolve(id, { ok: true })).toBe(false);
});
