import { patchScript } from "../scripts/store.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTurn } from "../runtime/loop.ts";
import { deleteConversation, loadLedger, newConversation, stopTurn } from "../runtime/store.ts";
import { LOCAL_TOOL_NAMES, localScope, runLocalTool } from "./local-tools.ts";
import { abortLocalProcesses } from "./local-process.ts";
import { dynamicToolIds, loadToolRegistry } from "./registry.ts";
import type { CompletionResult } from "../types.ts";

const repoRoot = join(import.meta.dir, "../..");
const response = (name: string, args: Record<string, unknown>): CompletionResult => ({
  finish: "tool_calls", content: "", attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [],
  toolCalls: [{ id: name, name, arguments: { ...args, reason: "验证本地工具" } }],
});

test("filesystem tools read and write the scripts directory", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-script-fs-"));
  try {
    expect(await patchScript(dataDir, { filename: "saved.sh", patch: "--- /dev/null\n+++ b/saved.sh\n@@ -0,0 +1 @@\n+printf saved\n" })).toMatchObject({ ok: true });
    const scripts = join(dataDir, "scripts"), saved = join(scripts, "saved.sh");
    expect(await runLocalTool("local.fs_read", { items: [{ path: saved }] }, dataDir, "cv_01")).toMatchObject({ ok: true, results: [{ ok: true, content: "printf saved\n" }] });
    expect(await runLocalTool("local.fs_write", { path: saved, content: "printf overwritten\n" }, dataDir, "cv_01")).toMatchObject({ ok: true });
    expect(await runLocalTool("local.fs_read", { items: [{ path: saved }] }, dataDir, "cv_01")).toMatchObject({ ok: true, results: [{ ok: true, content: "printf overwritten\n" }] });
    expect(await runLocalTool("local.fs_write", { path: join(scripts, "new.sh"), content: "printf new\n" }, dataDir, "cv_01")).toMatchObject({ ok: true });
    expect(await runLocalTool("local.fs_mkdir", { path: join(scripts, "nested") }, dataDir, "cv_01")).toMatchObject({ ok: true });
    expect(await runLocalTool("local.fs_write", { path: join(dataDir, "ordinary.txt"), content: "data" }, dataDir, "cv_01")).toMatchObject({ ok: true });
    expect(await runLocalTool("local.fs_delete", { path: join(scripts, "new.sh") }, dataDir, "cv_01")).toMatchObject({ ok: true });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("local tools are discoverable and load through the existing catalog before executing in the loop", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-local-loop-"));
  let step = 0;
  const registry = loadToolRegistry(repoRoot);
  for (const name of LOCAL_TOOL_NAMES) {
    expect(dynamicToolIds(registry)).toContain(name);
    expect(registry.tools[name]).toBeTruthy();
  }
  try {
    expect(await patchScript(dataDir, { filename: "run.sh", patch: "--- /dev/null\n+++ b/run.sh\n@@ -0,0 +1 @@\n+printf local-execution-ok\n" })).toMatchObject({ ok: true });
    const reply = await handleTurn({ dataDir, repoRoot, provider: { complete: async () => {
      if (step++ === 0) return response("catalog.add", { names: ["local.run"] });
      if (step === 2) return response("local.run", { filename: "run.sh", cwd: dataDir });
      return response("finishTurn", { text: "完成" });
    } } }, { userInput: "验证本地命令", submittedAt: new Date().toISOString() });
    expect(reply.output).toEqual({ kind: "reply", text: "完成" });
    const record = loadLedger(dataDir, reply.conversationId).toolIO.find(item => item.name === "local.run");
    expect(JSON.parse(record!.return.text)).toMatchObject({ ok: true, stdout: "local-execution-ok", exitCode: 0 });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("stop and delete terminate only their conversation's local processes even when the turn is idle", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-local-stop-"));
  const first = newConversation(dataDir).conversationId!;
  let second = "";
  try {
    expect(await patchScript(dataDir, { filename: "sleep.sh", patch: "--- /dev/null\n+++ b/sleep.sh\n@@ -0,0 +1 @@\n+sleep 30\n" })).toMatchObject({ ok: true });
    const a = await runLocalTool("local.process_start", { filename: "sleep.sh", cwd: dataDir }, dataDir, first);
    second = newConversation(dataDir).conversationId!;
    const b = await runLocalTool("local.process_start", { filename: "sleep.sh", cwd: dataDir }, dataDir, second);
    stopTurn(dataDir);
    expect(await runLocalTool("local.process_status", { processId: b.processId }, dataDir, second)).toMatchObject({ status: "stopped" });
    expect(await runLocalTool("local.process_status", { processId: a.processId }, dataDir, first)).toMatchObject({ status: "running" });
    deleteConversation(dataDir, first);
    expect(await runLocalTool("local.process_status", { processId: a.processId }, dataDir, first)).toMatchObject({ status: "stopped" });
  } finally {
    abortLocalProcesses(localScope(dataDir, first));
    if (second) abortLocalProcesses(localScope(dataDir, second));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
