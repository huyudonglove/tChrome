import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTurn } from "./runtime/loop.ts";
import { loadLedger, loadTurn } from "./runtime/store.ts";
import type { CompletionResult, Provider, ToolCall } from "./types.ts";

const repoRoot = join(import.meta.dir, "..");
const result = (partial: Partial<CompletionResult>): CompletionResult => ({
  finish: "tool_calls", content: "", toolCalls: [], attempts: 1,
  parseOk: true, schemaOk: true, faultCode: null, missing: [], ...partial,
});
const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id, name, arguments: { reason: "执行当前步骤", affectsPage: false, ...args },
});
const finish = () => result({ toolCalls: [call("finish", "finishTurn", { text: "任务完成" })] });
const invalid = () => result({ schemaOk: false, faultCode: "missing_required", missing: ["reason"],
  toolCalls: [{ id: "invalid", name: "page.get_summary", arguments: {} }],
});
const emptyReply = () => result({ finish: "stop" });

async function run(results: CompletionResult[], verify: (context: {
  reply: Awaited<ReturnType<typeof handleTurn>>;
  turn: ReturnType<typeof loadTurn>;
  ledger: ReturnType<typeof loadLedger>;
  modelRequests: number;
  browserCalls: string[];
}) => void) {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-loop-usage-"));
  let modelRequests = 0;
  const browserCalls: string[] = [];
  const provider: Provider = { complete: async () => {
    const next = results[modelRequests++];
    // Keep a broken implementation bounded without hiding its extra requests.
    return next ?? result({ finish: "error", faultCode: "unexpected_extra_request" });
  } };
  try {
    const reply = await handleTurn({ dataDir, repoRoot, provider, host: { execute: async (name) => {
      browserCalls.push(name);
      return { ok: true };
    } } }, { userInput: "完成多步任务", submittedAt: "2026-09-07T00:00:00.000Z" });
    verify({ reply, turn: loadTurn(dataDir, reply.conversationId, reply.turnId),
      ledger: loadLedger(dataDir, reply.conversationId), modelRequests, browserCalls });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
}

test("more than 20 successful tool rounds can finish normally", async () => {
  const steps = Array.from({ length: 25 }, (_, index) => result({
    toolCalls: [call(`page_${index}`, "page.get_summary")],
  }));
  await run([...steps, finish()], ({ reply, turn, ledger, modelRequests, browserCalls }) => {
    expect(reply.output).toEqual({ kind: "reply", text: "任务完成" });
    expect(ledger.status).toBe("idle");
    expect(modelRequests).toBe(26);
    expect(browserCalls).toHaveLength(25);
    expect(turn.usage).toEqual({ modelRequests: 26, toolCalls: 26 });
  });
});

test("one model response counts every executed browser, resident and closing tool", async () => {
  await run([result({ toolCalls: [
    call("page", "page.get_summary"),
    call("note", "notes.write", { key: "finding", value: "已核实" }),
    call("finish", "finishTurn", { text: "任务完成" }),
  ] })], ({ reply, turn, ledger, modelRequests, browserCalls }) => {
    expect(reply.output).toEqual({ kind: "reply", text: "任务完成" });
    expect(modelRequests).toBe(1);
    expect(browserCalls).toEqual(["page.get_summary"]);
    expect(ledger.notes.finding).toBe("已核实");
    expect(turn.usage).toEqual({ modelRequests: 1, toolCalls: 3 });
  });
});

test("a valid tool round resets consecutive invalid submission count", async () => {
  await run([invalid(), emptyReply(), result({ toolCalls: [call("valid", "page.get_summary")] }),
    invalid(), emptyReply(), finish()], ({ reply, turn, modelRequests, browserCalls }) => {
    expect(reply.output).toEqual({ kind: "reply", text: "任务完成" });
    expect(modelRequests).toBe(6);
    expect(browserCalls).toEqual(["page.get_summary"]);
    expect(turn.usage).toEqual({ modelRequests: 6, toolCalls: 2 });
  });
});

test("three consecutive invalid submissions still stop without executing invalid calls", async () => {
  await run([invalid(), emptyReply(), invalid(), finish()], ({ reply, turn, ledger, modelRequests, browserCalls }) => {
    expect(reply.output).toEqual({ kind: "error", faultCode: "missing_required" });
    expect(ledger.status).toBe("failed");
    expect(modelRequests).toBe(3);
    expect(browserCalls).toEqual([]);
    expect(turn.usage).toEqual({ modelRequests: 3, toolCalls: 0 });
  });
});

test("finishTurn missing required text is rejected before execution three times", async () => {
  const emptyFinish = () => result({ toolCalls: [call("empty_finish", "finishTurn")] });
  await run([emptyFinish(), emptyFinish(), emptyFinish(), finish()], ({ reply, turn, ledger, modelRequests, browserCalls }) => {
    expect(reply.output).toEqual({ kind: "error", faultCode: "missing_required" });
    expect(ledger.status).toBe("failed");
    expect(modelRequests).toBe(3);
    expect(browserCalls).toEqual([]);
    expect(turn.usage).toEqual({ modelRequests: 3, toolCalls: 0 });
  });
});
