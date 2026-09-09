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
  toolCalls: [{ id: name, name, arguments: { ...args, reason: "验证本地工具", affectsPage: false } }],
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
    const reply = await handleTurn({ dataDir, repoRoot, provider: { complete: async () => {
      if (step++ === 0) return response("catalog.add", { names: ["local.run"] });
      if (step === 2) return response("local.run", { command: "printf local-execution-ok", cwd: dataDir });
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
    const a = await runLocalTool("local.process_start", { command: "sleep 30", cwd: dataDir }, dataDir, first);
    second = newConversation(dataDir).conversationId!;
    const b = await runLocalTool("local.process_start", { command: "sleep 30", cwd: dataDir }, dataDir, second);
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
