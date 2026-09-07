import { expect, spyOn, test } from "bun:test";

test("background dispatch continues without panel messages and resumes on alarms", async () => {
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  let interval: () => void = () => {};
  let alarmListener: (alarm: { name: string }) => void = () => {};
  let keepAliveCalls = 0;
  let alarmCreated = false;
  let request: { id: string; name: string } | null = null;
  const results: string[] = [];
  let active = true;
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    sidePanel: { setPanelBehavior: () => {} },
    runtime: {
      getPlatformInfo: (callback: () => void) => { keepAliveCalls++; callback(); },
      onMessage: { addListener: () => {} },
    },
    alarms: {
      create: (name: string, options: { periodInMinutes: number }) => {
        alarmCreated = name === "tchrome-tool-pump" && options.periodInMinutes === 0.5;
      },
      onAlarm: { addListener: (callback: typeof alarmListener) => { alarmListener = callback; } },
    },
  } });
  const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
    interval = callback;
    return 0;
  }) as typeof setInterval);
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: string, options?: RequestInit) => {
    if (url.endsWith("/session")) return Response.json({ status: active ? "running" : "idle" });
    if (url.endsWith("/tool-request")) return Response.json({ request });
    if (url.endsWith("/tool-result")) {
      const body = JSON.parse(options?.body as string);
      results.push(body.id);
      expect(body.result).toBeDefined();
      request = null;
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch);
  try {
    await import("./background.ts");
    await Bun.sleep(0);
    expect(alarmCreated).toBe(true);
    request = { id: "after-panel-close", name: "list_browser_tools" };
    interval();
    await Bun.sleep(0);
    expect(results).toEqual(["after-panel-close"]);
    expect(keepAliveCalls).toBeGreaterThan(0);
    active = false;
    interval();
    await Bun.sleep(0);
    request = { id: "after-worker-wakeup", name: "list_browser_tools" };
    alarmListener({ name: "tchrome-tool-pump" });
    await Bun.sleep(0);
    expect(results).toEqual(["after-panel-close", "after-worker-wakeup"]);
  } finally {
    fetchSpy.mockRestore();
    intervalSpy.mockRestore();
    if (originalChrome) Object.defineProperty(globalThis, "chrome", originalChrome);
    else Reflect.deleteProperty(globalThis, "chrome");
  }
});
