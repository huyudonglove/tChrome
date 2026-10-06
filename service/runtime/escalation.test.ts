import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadToolRegistry } from "../tools/registry.ts";
import {
  escalate,
  substantiveStreak,
  BUDGET_NUDGE_MARKER,
  READ_ONLY_PROMPT,
  READ_ONLY_SECOND,
  READ_ONLY_GRACE,
  READ_ONLY_FINAL,
  READ_ONLY_HARD,
} from "./escalation.ts";
import type { ToolIOItem } from "../types.ts";

const row = (name: string, args: Record<string, unknown> = {}): ToolIOItem => ({
  callId: `call_${name}_${Math.random().toString(36).slice(2, 8)}`,
  name,
  arguments: args,
  turnId: "tn_01",
  return: { stage: "complete", totalChars: 0, text: "" },
});

// 测试用最小集合：只读名与实质性名各取两个，与线上名单无关；
// 线上只读判定唯一来源是 registry（见文末测试），这里只验计数逻辑。
const READ = new Set(["local_fs_read", "see_page"]);

const reads = (n: number): ToolIOItem[] =>
  Array.from({ length: n }, (_, i) => row(i % 2 === 0 ? "local_fs_read" : "see_page"));

test("29 reads stay quiet, 30th prompts for substantive action", () => {
  expect(escalate(reads(READ_ONLY_PROMPT - 1), "see_page", READ).action).toBe("continue");
  const hint = escalate(reads(READ_ONLY_PROMPT), "see_page", READ) as { action: string; text: string };
  expect(hint.action).toBe("hint");
  expect(hint.text).toContain(BUDGET_NUDGE_MARKER);
  expect(hint.text).toContain("实质性");
});

test("substantive action resets the streak", () => {
  const rows = [...reads(READ_ONLY_PROMPT - 1), row("page_click"), ...reads(5)];
  expect(substantiveStreak(rows, READ)).toBe(5);
  expect(escalate(rows, "see_page", READ).action).toBe("continue");
});

test("neutral bookkeeping neither accumulates nor resets", () => {
  const rows = [...reads(10), row("observation_write"), row("askUser"), ...reads(5)];
  expect(substantiveStreak(rows, READ)).toBe(15);
  expect(escalate(rows, "see_page", READ).action).toBe("continue");
});

test("local_run preserves read streak regardless of command and remains a workspace business call", async () => {
  const { buildWorkspaceSuggestion, defaultWorkspaceCallIds } = await import("./workspace.ts");
  const { emptyLedger } = await import("./store.ts");
  const rows = reads(READ_ONLY_PROMPT - 1);
  for (const command of ["git diff", "git status --short", "bun test", "echo changed > result.txt"]) {
    rows.push(row("local_run", { command }));
    expect(substantiveStreak(rows, READ)).toBe(READ_ONLY_PROMPT - 1);
    expect(escalate(rows, "local_run", READ).action).toBe("continue");
  }
  rows.push(row("local_fs_read"));
  expect(escalate(rows, "local_fs_read", READ).action).toBe("hint");
  const call = { ...row("local_run", { command: "git diff" }), batchId: "batch_01" };
  rows.push(call);
  expect(substantiveStreak(rows, READ)).toBe(READ_ONLY_PROMPT);
  expect(escalate(rows, "local_run", READ).action).toBe("hint");
  expect(buildWorkspaceSuggestion([call])).not.toBeNull();
  const ledger = emptyLedger("cv_test");
  ledger.toolIO = [call];
  expect(defaultWorkspaceCallIds(ledger, "tn_01")).toEqual([call.callId]);
});

test("60 reads second hint, 63rd is a final warning to the model, 66th interrupts", () => {
  const second = escalate(reads(READ_ONLY_SECOND), "see_page", READ) as { action: string; text: string };
  expect(second.action).toBe("hint");
  expect(second.text).toContain("仅剩");
  expect(second.text).toContain(String(READ_ONLY_GRACE));

  const lastChance = escalate(reads(READ_ONLY_SECOND + READ_ONLY_GRACE - 1), "see_page", READ);
  expect(lastChance.action).toBe("hint");

  // 最后通牒是给模型看的 hint，不是中断：模型还有收口机会。
  const fin = escalate(reads(READ_ONLY_FINAL), "see_page", READ) as { action: string; text: string };
  expect(fin.action).toBe("hint");
  expect(fin.text).toContain(BUDGET_NUDGE_MARKER);
  expect(fin.text).toContain("最后通牒");
  expect(fin.text).toContain("checkContinue");

  const stillHint = escalate(reads(READ_ONLY_HARD - 1), "see_page", READ);
  expect(stillHint.action).toBe("hint");

  const over = escalate(reads(READ_ONLY_HARD), "see_page", READ) as { action: string; text: string };
  expect(over.action).toBe("interrupt");
  expect(over.text).not.toContain(BUDGET_NUDGE_MARKER);
});

test("checkContinue(true) resets the streak, anything else stays neutral", () => {
  expect(substantiveStreak([...reads(READ_ONLY_HARD), row("checkContinue", { cont: true })], READ)).toBe(0);
  expect(escalate([...reads(READ_ONLY_HARD), row("checkContinue", { cont: true })], "see_page", READ).action).toBe("continue");
  expect(substantiveStreak([...reads(10), row("checkContinue", { cont: false }), ...reads(5)], READ)).toBe(15);
  expect(substantiveStreak([...reads(10), row("checkContinue", {}), ...reads(5)], READ)).toBe(15);
});

test("interrupt then substantive recovers in a new segment", () => {
  const rows = [...reads(READ_ONLY_HARD), row("local_fs_write"), ...reads(2)];
  expect(substantiveStreak(rows, READ)).toBe(2);
  expect(escalate(rows, "see_page", READ).action).toBe("continue");
});

test("every registry tool carries an explicit readOnly flag", () => {
  const registry = loadToolRegistry(join(import.meta.dir, "../.."));
  const toolCaps = registry.capabilities.filter((c) => c.kind === "tool");
  expect(toolCaps.length).toBeGreaterThan(0);
  // 每个工具都必须显式标记，不允许 undefined 混过去；只读判定只看这一处。
  for (const cap of toolCaps) expect(typeof cap.readOnly).toBe("boolean");
});

for (const resetTool of ["local_fs_write", "checkContinue"]) {
  test(`loop delivers budget hints across bookkeeping and clears them after ${resetTool}`, async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { handleTurn } = await import("./loop.ts");
    const { ensureSession, loadLedger, saveLedger } = await import("./store.ts");
    const dataDir = mkdtempSync(join(tmpdir(), "tchrome-budget-"));
    try {
      const session = ensureSession(dataDir);
      const ledger = loadLedger(dataDir, session.conversationId);
      ledger.loadedToolIds = ["local_fs_list", "local_fs_write", "local_run"];
      // A previous turn's reminder must not leak into this turn's first request.
      ledger.runtimeNotices.push({ id: "rt_999", kind: "budget", scope: "turn", text: BUDGET_NUDGE_MARKER });
      saveLedger(dataDir, ledger);
      let request = 0;
      const provider = {
        complete: async (input: { messages: { content: string }[] }) => {
          request++;
          const runtime = input.messages[1]!.content.match(/<runtime\b[\s\S]*?<\/runtime>/)?.[0] ?? "";
          const hasBudget = runtime.includes('kind="budget"');
          expect(hasBudget).toBe(request >= 2 && request <= 4);
          const toolCalls = request === 1
            ? Array.from({ length: READ_ONLY_PROMPT }, (_, index) => ({
              id: `read_${index}`, name: "local_fs_list", arguments: { path: dataDir, limit: 1 },
            }))
            : request === 2
              ? [{ id: "note", name: "workspace_write", arguments: { reason: "记下结果", op: "读取目录", value: "目录已读取" } }]
              : request === 3
                ? [{ id: "inspect", name: "local_run", arguments: { reason: "读取状态", cwd: dataDir, command: "pwd" } }]
              : request === 4
                ? [{ id: "reset", name: resetTool, arguments: resetTool === "checkContinue"
                  ? { reason: "继续执行", cont: true }
                  : { reason: "写入结果", path: join(dataDir, "result.txt"), content: "done" } }]
                : [{ id: "finish", name: "finishTurn", arguments: { reason: "完成", text: "完成" } }];
          return { finish: "tool_calls", content: "", toolCalls, attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [] };
        },
      };
      const reply = await handleTurn({ dataDir, repoRoot: join(import.meta.dir, "../.."), provider } as never, {
        userInput: "读取目录并保存结果", submittedAt: "2026-10-06",
      });
      expect(reply.stopReason).toEqual({ kind: "reply", text: "完成" });
      expect(request).toBe(5);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
}
