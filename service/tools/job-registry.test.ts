import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spyOn } from "bun:test";
import { abortAllJobs, jobScope, runJobTool, withJobHeartbeat } from "./job-registry.ts";
import { runServiceTool } from "./service-tools.ts";
import { executeTool } from "./execute.ts";
import { loadToolRegistry } from "./registry.ts";
import { patchScript } from "../scripts/store.ts";
import type { BrowserHost } from "../types.ts";

let dataDir: string;
let conversationId: string;
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "tchrome-job-"));
  conversationId = "cv_job_test";
});
afterEach(() => {
  abortAllJobs();
  rmSync(dataDir, { recursive: true, force: true });
});

test("HTTP heartbeat returns jobId and job.status later delivers the full result", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const mock = spyOn(globalThis, "fetch").mockImplementation((async () => {
    await gate;
    return new Response("payload");
  }) as typeof fetch);
  try {
    const pending = runServiceTool(dataDir, "send_http", {
      url: "https://example.com/slow",
      heartbeatSec: 1,
      reason: "长请求",
      affectsPage: false,
    }, undefined, conversationId);
    const beat = await pending;
    expect(beat).toMatchObject({ ok: true, heartbeat: true, status: "running", toolName: "send_http" });
    const jobId = String((beat as { jobId: string }).jobId);
    expect(jobId).toMatch(/^job_[0-9]{2,}$/);
    const running = await runJobTool("job.status", { jobId }, jobScope(dataDir, conversationId));
    expect(running).toMatchObject({ ok: true, jobId, status: "running" });
    release();
    await Bun.sleep(20);
    const done = await runJobTool("job.status", { jobId }, jobScope(dataDir, conversationId));
    expect(done).toMatchObject({ ok: true, status: "completed" });
    expect(JSON.stringify((done as { result: { text: string } }).result)).toContain("payload");
  } finally { mock.mockRestore(); }
});

test("job.stop cancels an in-flight HTTP heartbeat request", async () => {
  let seenAbort = false;
  const mock = spyOn(globalThis, "fetch").mockImplementation((async (_url: RequestInfo | URL, init?: RequestInit) => {
    await new Promise<void>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) { seenAbort = true; reject(new Error("aborted")); return; }
      signal?.addEventListener("abort", () => { seenAbort = true; reject(new Error("aborted")); });
    });
    return new Response("never");
  }) as typeof fetch);
  try {
    const beat = await runServiceTool(dataDir, "send_http", {
      url: "https://example.com/hang",
      heartbeatSec: 1,
      reason: "取消",
      affectsPage: false,
    }, undefined, conversationId);
    const jobId = String((beat as { jobId: string }).jobId);
    const stopped = await runJobTool("job.stop", { jobId }, jobScope(dataDir, conversationId));
    expect(stopped).toMatchObject({ ok: true, jobId, status: "stopped" });
    await Bun.sleep(20);
    expect(seenAbort).toBe(true);
  } finally { mock.mockRestore(); }
});

test("without heartbeatSec the HTTP call waits for the complete body", async () => {
  const mock = spyOn(globalThis, "fetch").mockResolvedValue(new Response("done"));
  try {
    const result = await runServiceTool(dataDir, "send_http", {
      url: "https://example.com",
      reason: "同步",
      affectsPage: false,
    }, undefined, conversationId);
    expect(result).toMatchObject({ ok: true, text: "done" });
    expect(result).not.toHaveProperty("heartbeat");
  } finally { mock.mockRestore(); }
});

test("job tools reject foreign conversation scopes", async () => {
  const beat = await withJobHeartbeat({
    dataDir,
    scope: jobScope(dataDir, conversationId),
    toolName: "send_http",
    heartbeatSec: 1,
    start: async () => { await Bun.sleep(50); return { ok: true }; },
  });
  const jobId = String((beat as { jobId: string }).jobId);
  const foreign = await runJobTool("job.status", { jobId }, jobScope(dataDir, "cv_other"));
  expect(foreign).toMatchObject({ ok: false });
});

test("execute_javascript heartbeat uses job.status and forwards the eventual script result", async () => {
  const repoRoot = join(import.meta.dir, "../..");
  const tools = loadToolRegistry(repoRoot);
  expect(tools.tools["job.status"]).toBeTruthy();
  expect(tools.tools["job.stop"]).toBeTruthy();
  expect(tools.toolGroups.baseToolsIds).toContain("job.status");
  expect(tools.toolGroups.baseToolsIds).toContain("job.stop");
  const filename = "beat.js";
  expect(await patchScript(dataDir, {
    filename,
    patch: `--- /dev/null\n+++ b/${filename}\n@@ -0,0 +1 @@\n+1+1\n`,
  })).toMatchObject({ ok: true });

  let release!: (value: Record<string, unknown>) => void;
  const gate = new Promise<Record<string, unknown>>((resolve) => { release = resolve; });
  const host: BrowserHost = {
    execute: async () => ({ ok: true, type: "number", value: 2 }),
    executeTracked: () => ({ id: "br_01", result: gate.then((value) => value as never) }),
    abortById: () => true,
  };
  const pending = executeTool({
    name: "execute_javascript",
    arguments: { filename, tabId: 1, reason: "长脚本", affectsPage: false, heartbeatSec: 1 },
    dataDir,
    conversationId,
    browserNames: ["execute_javascript"],
    host,
    lookup: { unusedTools: [], knownTools: ["execute_javascript", "job.status", "job.stop"], enabledTools: ["execute_javascript", "job.status", "job.stop"] },
  });
  const beat = JSON.parse((await pending).text) as Record<string, unknown>;
  expect(beat).toMatchObject({ ok: true, heartbeat: true, toolName: "execute_javascript" });
  const jobId = String(beat.jobId);
  release({ ok: true, type: "number", value: 2, tabId: 1 });
  await Bun.sleep(20);
  const status = await executeTool({
    name: "job.status",
    arguments: { jobId, reason: "查询", affectsPage: false },
    dataDir,
    conversationId,
    browserNames: [],
    lookup: { unusedTools: [], knownTools: ["job.status"], enabledTools: ["job.status"] },
  });
  const viewed = JSON.parse(status.text) as Record<string, unknown>;
  expect(viewed).toMatchObject({ ok: true, status: "completed" });
  expect(JSON.stringify((viewed as { result: { value: number } }).result)).toContain('"value":2');
});
