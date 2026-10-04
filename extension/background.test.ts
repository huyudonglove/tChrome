import { expect, spyOn, test } from "bun:test";

test("background dispatch continues without panel messages and resumes on alarms", async () => {
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  let interval: () => void = () => {};
  let alarmListener: (alarm: { name: string }) => void = () => {};
  let keepAliveCalls = 0;
  let alarmCreated = false;
  let request: { id: string; name: string } | null = null;
  const results: string[] = [];
  let lastResult: any;
  let active = true;
  let version: string | undefined = "unbundled";
  let status = 200;
  let reportsFail = false;
  let executions = 0;
  let hanging = false;
  const storage: Record<string, any> = {};
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    storage: {session: {get: async () => storage, set: async (values: any) => { Object.assign(storage, values); }}},
    windows: { getAll: async () => {
      if (hanging) return new Promise(() => {});
      executions++;
      return [];
    } },
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
  // background.ts now owns two timers: the 1s pump tick and the per-claim
  // heartbeat. Keep only the tick handle so the test still drives the pump.
  const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms?: number) => {
    if (ms === 1000) interval = callback;
    return 0;
  }) as typeof setInterval);
  const realSetTimeout = globalThis.setTimeout;
  const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    // The executor watchdog uses 60s; fire those immediately so the test stays fast.
    return realSetTimeout(callback, ms === 60_000 ? 0 : ms, ...args);
  }) as typeof setTimeout);
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: string, options?: RequestInit) => {
    if (url.endsWith("/session")) return Response.json({ status: active ? "running" : "idle" });
    if (url.includes("/tool-request?")) {
      expect(new URL(url).searchParams.get("executorVersion")).toBe("unbundled");
      return Response.json({ request, executorVersion: version }, { status });
    }
    if (url.includes("/tool-result?")) {
      const body = JSON.parse(options?.body as string);
      results.push(body.id);
      lastResult = body.result;
      expect(body.result).toBeDefined();
      // The service consumes the request whether or not the result is accepted,
      // so the queue never hands the same id back and the pump cannot hot-loop.
      request = null;
      if (reportsFail) return Response.json({ok: false}, {status: 503});
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
    request = { id: "report-failure", name: "list_tabs" };
    reportsFail = true;
    interval();
    await Bun.sleep(60);
    // A refused report is retried with backoff but never re-executed.
    expect(results.at(-1)).toBe("report-failure");
    expect(executions).toBe(1);
    reportsFail = false;
    interval();
    await Bun.sleep(0);
    expect(executions).toBe(1);
    // Simulate a claim left by a previous worker that stopped during execution.
    // The records map is keyed by request id, not by a literal `id` field.
    storage['tchrome-tool-executions'] = {'interrupted-worker': {}};
    request = {id: 'interrupted-worker', name: 'list_tabs'};
    interval();
    await Bun.sleep(0);
    expect(executions).toBe(1);
    expect(results.at(-1)).toBe('interrupted-worker');
    expect(lastResult).toMatchObject({ok: false, faultCode: 'tool_execution_failed'});
    // A claim that is still inside the TTL is treated as a live worker: refuse it.
    storage['tchrome-tool-executions'] = {'live-worker': {claimedAt: Date.now()}};
    request = {id: 'live-worker', name: 'list_tabs'};
    interval();
    await Bun.sleep(0);
    expect(executions).toBe(1);
    expect(results.at(-1)).toBe('live-worker');
    expect(lastResult).toMatchObject({ok: false, faultCode: 'tool_execution_failed'});
    // A claim older than the TTL cannot belong to a running worker, so it is
    // reclaimed and the request runs again instead of failing forever.
    storage['tchrome-tool-executions'] = {'expired-worker': {claimedAt: Date.now() - 120_000}};
    request = {id: 'expired-worker', name: 'list_tabs'};
    interval();
    await Bun.sleep(0);
    expect(executions).toBe(2);
    expect(results.at(-1)).toBe('expired-worker');
    expect(lastResult).toMatchObject({ok: true});
    // A claim whose beat stopped is abandoned even inside the TTL: the worker
    // was reclaimed by Chrome mid-execution, so replaying is safe and needed.
    storage['tchrome-tool-executions'] = {'dead-beat-worker': {
      claimedAt: Date.now() - 1_000, heartbeatAt: Date.now() - 90_000,
    }};
    request = {id: 'dead-beat-worker', name: 'list_tabs'};
    interval();
    await Bun.sleep(0);
    expect(executions).toBe(3);
    expect(results.at(-1)).toBe('dead-beat-worker');
    expect(lastResult).toMatchObject({ok: true});
    storage['tchrome-tool-executions'] = {'completed-worker': {result: {ok: true, tabs: []}}};
    request = {id: 'completed-worker', name: 'list_tabs'};
    interval();
    await Bun.sleep(0);
    // Still 3: the expired and dead-beat claims were the only extra executions.
    expect(executions).toBe(3);
    expect(results.at(-1)).toBe('completed-worker');
    expect(lastResult).toEqual({ok: true, tabs: []});
    // A renderer that never resolves must not wedge the pump: the watchdog
    // reports tool_timeout and the very next tick still executes tools.
    hanging = true;
    request = { id: "hung-renderer", name: "list_tabs" };
    interval();
    await Bun.sleep(20);
    expect(results.at(-1)).toBe("hung-renderer");
    expect(lastResult).toMatchObject({ ok: false, faultCode: "tool_timeout" });
    hanging = false;
    request = { id: "after-hang", name: "list_tabs" };
    interval();
    await Bun.sleep(0);
    expect(results.at(-1)).toBe("after-hang");
    expect(lastResult).toMatchObject({ ok: true });
    // The service reads its tab snapshot through __currentTabs. It has to reach
    // readOpenTabs, not runBrowserTool, which resolves a tab first and would
    // reject the request for a missing tabId.
    request = { id: "current-tabs", name: "__currentTabs" };
    interval();
    await Bun.sleep(0);
    expect(results.at(-1)).toBe("current-tabs");
    expect(lastResult).toMatchObject({ ok: true, windows: [] });
    const delivered = results.slice();
    // Reject both old services that omit a version and incompatible builds.
    request = { id: "must-not-execute", name: "list_browser_tools" };
    for (const nextVersion of [undefined, "different-build", "unbundled"]) {
      version = nextVersion;
      status = nextVersion === "unbundled" ? 409 : 200;
      interval();
      await Bun.sleep(0);
      expect(results).toEqual(delivered);
    }
  } finally {
    fetchSpy.mockRestore();
    intervalSpy.mockRestore();
    timeoutSpy.mockRestore();
    if (originalChrome) Object.defineProperty(globalThis, "chrome", originalChrome);
    else Reflect.deleteProperty(globalThis, "chrome");
  }
});
