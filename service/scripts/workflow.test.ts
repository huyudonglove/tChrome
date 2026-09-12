import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleTurn } from "../runtime/loop.ts";
import { loadLedger } from "../runtime/store.ts";
import { executeTool } from "../tools/execute.ts";
import type { CompletionResult, ToolCall } from "../types.ts";

const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: name, name, arguments: { reason: "脚本测试", affectsPage: false, ...args } });
const response = (toolCalls: ToolCall[]): CompletionResult => ({ finish: "tool_calls", content: "", attempts: 1, parseOk: true, schemaOk: true, missing: [], faultCode: null, toolCalls });
const patch = "--- /dev/null\n+++ b/demo.js\n@@ -0,0 +1 @@\n+(() => 42)()\n";

test("script patch returns status to the model before filename execution reaches the browser", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "script-workflow-"));
  let step = 0, executions = 0;
  try {
    const reply = await handleTurn({ dataDir, repoRoot: join(import.meta.dir, "../.."),
      host: { execute: async (name, input) => {
        executions++;
        expect(name).toBe("execute_javascript");
        expect(input).toEqual({ tab: 12, code: "(() => 42)()\n" });
        return { ok: true, type: "number", value: 42, tab: 12 };
      } }, provider: { complete: async ({ messages }) => {
        step++;
        if (step === 1) return response([call("catalog.add", { names: ["script_patch", "execute_javascript"] })]);
        if (step === 2) return response([call("script_patch", { filename: "demo.js", patch })]);
        if (step === 3) {
          expect(executions).toBe(0);
          expect(messages[1]!.content).toContain('"operation": "created"');
          return response([call("execute_javascript", { filename: "demo.js", tab: 12 })]);
        }
        return response([call("finishTurn", { text: "完成" })]);
      } } }, { userInput: "执行脚本", submittedAt: "now" });
    expect(reply.output).toEqual({ kind: "reply", text: "完成" });
    expect(executions).toBe(1);
    const ledger = loadLedger(dataDir, reply.conversationId);
    expect(ledger.toolIO.find(row => row.name === "execute_javascript")!.arguments).toHaveProperty("filename", "demo.js");
    expect(ledger.toolIO.find(row => row.name === "execute_javascript")!.arguments).not.toHaveProperty("code");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test.each(["execute_javascript", "local.run", "local.process_start"])("patch and %s in one model batch execute neither operation", async name => {
  const dataDir = mkdtempSync(join(tmpdir(), "script-batch-"));
  let step = 0, executions = 0;
  try {
    const reply = await handleTurn({ dataDir, repoRoot: join(import.meta.dir, "../.."), host: { execute: async () => { executions++; return { ok: true }; } },
      provider: { complete: async () => ++step === 1
        ? response([call("catalog.add", { names: ["script_patch", name] })])
        : response([call("script_patch", { filename: "demo.js", patch }), call(name, { filename: "demo.js", ...(name === "execute_javascript" ? { tab: 12 } : { cwd: dataDir }) })]) },
    }, { userInput: "执行脚本", submittedAt: "now" });
    expect(reply.output.kind).toBe("error");
    expect(executions).toBe(0);
    expect(existsSync(join(dataDir, "scripts", "demo.js"))).toBe(false);
    expect(JSON.stringify(loadLedger(dataDir, reply.conversationId).toolIO)).toContain("script_steps_separate");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("missing files and inline code never reach Chrome", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "script-missing-"));
  try {
    for (const args of [{ filename: "missing.js" }, { filename: "../escape.js" }, { code: "42" }]) {
      const result = await executeTool({ name: "execute_javascript", arguments: args, dataDir, browserNames: ["execute_javascript"],
        host: { execute: async () => { throw new Error("unexpected browser dispatch"); } }, lookup: { unusedTools: [], knownTools: [], enabledTools: [] } });
      expect(JSON.parse(result.text).ok).toBe(false);
      expect(result.text).not.toContain("unexpected browser dispatch");
    }
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
