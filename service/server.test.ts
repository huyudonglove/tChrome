import { expect, test } from "bun:test";
import { mkdtempSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.ts";
import { executorVersion } from "./executor-version.ts";
import { createToolBridge } from "./runtime/bridge.ts";

const base = "http://127.0.0.1:18788";
const extensionOrigin = `chrome-extension://${"a".repeat(32)}`;

test("外部网页在路由执行前被拒绝，包括简单 POST 和预检", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-origin-"));
  try {
    const server = createServer({ dataDir: dir, extensionOrigin });
    for (const method of ["GET", "POST", "OPTIONS"]) {
      const response = await server.fetch(new Request(`${base}/conversations/new`, {
        method, headers: { origin: "https://untrusted.example" },
      }));
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(existsSync(join(dir, "session.json"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("指定扩展允许预检和请求，其他扩展和 null origin 被拒绝", async () => {
  const server = createServer({ extensionOrigin });
  for (const method of ["GET", "OPTIONS"]) {
    const response = await server.fetch(new Request(`${base}/health`, {
      method, headers: { origin: extensionOrigin },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(extensionOrigin);
    expect(response.headers.get("vary")).toBe("Origin");
  }
  for (const origin of ["null", `chrome-extension://${"b".repeat(32)}`]) {
    expect((await server.fetch(new Request(`${base}/health`, { headers: { origin } }))).status).toBe(403);
  }
});

test("拒绝 DNS 重绑定地址和无 Origin 跨站请求，保留本机客户端", async () => {
  const server = createServer();
  expect((await server.fetch(new Request("http://rebind.example:18788/health"))).status).toBe(403);
  for (const site of ["cross-site", "same-site"]) {
    expect((await server.fetch(new Request(`${base}/health`, {
      headers: { "sec-fetch-site": site },
    }))).status).toBe(403);
  }
  expect((await server.fetch(new Request(`${base}/health`))).status).toBe(200);
});


test("连接设置 provider 与代理独立保存，拒绝无效更新", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-connection-"));
  const oldKey = Bun.env.SHININGSPACE_API_KEY;
  const oldDefault = Bun.env.TCHROME_PROVIDER;
  try {
    Bun.env.TCHROME_PROVIDER = "uuapi";
    Bun.env.SHININGSPACE_API_KEY = "test-key";
    writeFileSync(join(dir, "connection.json"), JSON.stringify({ enabled: false }));
    const server = createServer({ dataDir: dir });
    const read = async (instance = server) => (await instance.fetch(new Request(`${base}/connection`))).json();
    const update = (body: unknown) => server.fetch(new Request(`${base}/connection`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    expect((await read()).provider).toBe("uuapi");
    expect((await update({ provider: "shiningspace" })).status).toBe(200);
    expect(await read()).toMatchObject({ enabled: false, provider: "shiningspace" });
    expect((await update({ enabled: true })).status).toBe(200);
    expect(await read(createServer({ dataDir: dir }))).toMatchObject({ enabled: true, provider: "shiningspace" });
    for (const body of [{ provider: "unknown" }, { enabled: "yes" }, {}, null]) {
      expect((await update(body)).status).toBe(400);
    }
    expect(JSON.parse(readFileSync(join(dir, "connection.json"), "utf8"))).toEqual({ enabled: true, provider: "shiningspace" });
    expect(JSON.stringify(await read())).not.toContain("test-key");
  } finally {
    if (oldKey === undefined) delete Bun.env.SHININGSPACE_API_KEY;
    else Bun.env.SHININGSPACE_API_KEY = oldKey;
    if (oldDefault === undefined) delete Bun.env.TCHROME_PROVIDER;
    else Bun.env.TCHROME_PROVIDER = oldDefault;
    rmSync(dir, { recursive: true, force: true });
  }
});


test("扩展构建握手阻止旧工具执行并报告重载指引", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-executor-"));
  const repoRoot = join(import.meta.dir, "..");
  const bridge = createToolBridge(dir);
  try {
    const server = createServer({ dataDir: dir, repoRoot, bridge });
    const health = async () => (await server.fetch(new Request(`${base}/health`))).json();
    const version = executorVersion(repoRoot);
    expect((await health()).extension.status).toBe("unknown");
    for (const suffix of ["", "?executorVersion=old-build"]) {
      const pending = bridge.execute("handle_dialog", {});
      const response = await server.fetch(new Request(`${base}/tool-request${suffix}`));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ requests: [], faultCode: "executor_version_mismatch", executorVersion: version });
      expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining("chrome://extensions") });
      expect((await health()).extension.status).toBe("mismatch");
    }
    const pending = bridge.execute("handle_dialog", {});
    const listed = await server.fetch(new Request(`${base}/tool-request?executorVersion=${version}`));
    const body = await listed.json();
    expect(body.executorVersion).toBe(version);
    expect(body.requests[0].name).toBe("handle_dialog");
    expect((await health()).extension).toMatchObject({ status: "ready", actualVersion: version });
    const posted = await server.fetch(new Request(`${base}/tool-result?executorVersion=${version}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: body.requests[0].id, result: { ok: true } }),
    }));
    expect(posted.status).toBe(200);
    expect(await pending).toEqual({ ok: true });
  } finally {
    bridge.abort();
    rmSync(dir, { recursive: true, force: true });
  }
});


test("tabs_current 走扩展桥；停止释放桥接等待", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-open-tabs-bridge-"));
  const repoRoot = join(import.meta.dir, "..");
  let calls = 0;
  let wantTabs = true;
  const server = createServer({dataDir: dir, repoRoot, provider: {complete: async () => {
    calls++;
    if (wantTabs) {
      wantTabs = false;
      return {finish: "tool_calls", content: "", toolCalls: [{id: "tabs", name: "tabs_current", arguments: {reason: "查标签"}}], attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: []};
    }
    wantTabs = true;
    return {finish: "tool_calls", content: "", toolCalls: [{id: "reply", name: "finishTurn", arguments: {text: "完成"}}], attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: []};
  }}});
  const post = () => server.fetch(new Request(`${base}/turn`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({userInput: "你好", submittedAt: "now"})}));
  try {
    const version = executorVersion(repoRoot);
    await server.fetch(new Request(`${base}/tool-request?executorVersion=${version}`));
    const pending = post();
    await Bun.sleep(0);
    const request = server.bridge.list()[0]!;
    expect(request.name).toBe("__currentTabs");
    const snapshot = {ok: true, windows: [{windowId: 1, focused: true, tabs: [{tabId: 12, active: true, url: "https://example.com", title: "测试"}]}]};
    server.bridge.resolve(request.id, snapshot);
    expect((await (await pending).json()).stopReason.kind).toBe("reply");
    const stopped = post();
    await Bun.sleep(0);
    expect(server.bridge.list()[0]?.name).toBe("__currentTabs");
    await server.fetch(new Request(`${base}/stop`, {method: "POST"}));
    expect((await (await stopped).json()).stopReason).toEqual({ kind: "interrupted", initiatedBy: "user" });
    expect(server.bridge.list()).toEqual([]);
    expect(calls).toBeGreaterThan(0);
  } finally {server.bridge.abort(); rmSync(dir,{recursive: true,force:true});}
});

test("/browser-batch 校验任务、要求扩展在线，并经扩展桥在真实标签执行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-batch-"));
  const repoRoot = join(import.meta.dir, "..");
  const bridge = createToolBridge(dir);
  const server = createServer({ dataDir: dir, repoRoot, bridge });
  const version = executorVersion(repoRoot);
  const post = (body: unknown) => server.fetch(new Request(`${base}/browser-batch`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  try {
    expect((await post({ tasks: [] })).status).toBe(400);
    expect((await post({ tasks: [{ name: "   " }] })).status).toBe(400);
    expect((await post({ tasks: [{ name: "see_page", input: [] }] })).status).toBe(400);
    expect((await post({ tasks: [{ input: {} }] })).status).toBe(400);
    expect((await post({ tasks: [{ name: "see_page" }] })).status).toBe(503);
    expect(bridge.list()).toEqual([]);

    await server.fetch(new Request(`${base}/tool-request?executorVersion=${version}`));
    const pending = post({ tasks: [{ name: "see_page", input: { tabId: 1 } }, { name: "tabs_current" }] });
    let queued = bridge.list();
    for (let i = 0; i < 50 && queued.length < 2; i++) {
      await Bun.sleep(1);
      queued = bridge.list();
    }
    expect(queued.map((item) => item.name)).toEqual(["see_page", "tabs_current"]);
    // marker 只是本用例自定义的透传标记，不在 BrowserResult 内，故按 resolve 签名断言一次。
    for (const item of queued) bridge.resolve(item.id, { ok: true, marker: item.name } as Parameters<typeof bridge.resolve>[1]);

    const body = await (await pending).json() as { ok: boolean; count: number; results: { name: string; result: { marker?: string } }[] };
    expect(body.ok).toBe(true);
    expect(body.count).toBe(2);
    expect(body.results.map((item) => item.name)).toEqual(["see_page", "tabs_current"]);
    expect(body.results.map((item) => item.result.marker)).toEqual(["see_page", "tabs_current"]);
  } finally {
    bridge.abort();
    rmSync(dir, { recursive: true, force: true });
  }
});
