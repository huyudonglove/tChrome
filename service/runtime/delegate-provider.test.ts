import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureSession, loadLedger, primeActiveTask, saveLedger } from "./store.ts";
import { handleTurn } from "./loop.ts";
import type { CompletionResult, Provider } from "../types.ts";

const repoRoot = join(import.meta.dir, "../..");

const result = (partial: Partial<CompletionResult>): CompletionResult => ({
  finish: "tool_calls",
  content: "",
  toolCalls: [],
  attempts: 1,
  parseOk: true,
  schemaOk: true,
  faultCode: null,
  missing: [],
  ...partial,
});

/** 子代理请求的 System 是 executor 的 DEFAULT_SYSTEM_PROMPT，用它的首句把主模型请求区分开。 */
const isSubagentRequest = (messages: readonly { role: string; content: string }[]): boolean =>
  messages[0]?.role === "system" && (messages[0]?.content ?? "").startsWith("你是受限的 Subagent");

const packet = {
  id: "p1",
  role: "researcher",
  objective: "查证一个只读事实",
  facts: [],
  constraints: [],
  acceptanceCriteria: [],
  dependencies: [],
};

// 回归：tn_19 实测 delegate_subagent 一调就回 provider_unavailable（Subagent provider is missing），
// 根因是 loop.ts 调度工具时漏传 provider（execute.ts 对 input.provider 判空）。tn_10 的探针直接调
// executeTool、绕过了调度层，所以没测出来；这条用例必须从 handleTurn 真实入口走完整条链路。
test("handleTurn 真实入口下 delegate_subagent 拿得到 provider，返回体按 DAG 汇总", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-delegate-provider-"));
  try {
    primeActiveTask(dataDir);
    const session = ensureSession(dataDir);
    // delegate_subagent 不在默认装配集里，与被调用的真实会话一致：先把它加载进本会话工具清单。
    const seeded = loadLedger(dataDir, session.conversationId);
    seeded.loadedToolIds = [...new Set([...(seeded.loadedToolIds ?? []), "delegate_subagent"])];
    saveLedger(dataDir, seeded);

    let mainRequests = 0;
    const provider: Provider = {
      complete: async ({ messages }) => {
        if (isSubagentRequest(messages)) {
          return result({
            finish: "stop",
            content: JSON.stringify({ taskId: "p1", status: "success", summary: "查证完成", evidence: [] }),
          });
        }
        mainRequests += 1;
        if (mainRequests === 1) {
          return result({
            toolCalls: [{ id: "c1", name: "delegate_subagent", arguments: { reason: "端到端探测", packets: [packet] } }],
          });
        }
        return result({ toolCalls: [{ id: "c2", name: "finishTurn", arguments: { reason: "完成", text: "完成" } }] });
      },
    };

    await handleTurn(
      { dataDir, repoRoot, provider },
      { userInput: "端到端验证 delegate_subagent", submittedAt: "2026-10-07" },
    );

    const rows = loadLedger(dataDir, session.conversationId).toolIO.filter((row) => row.name === "delegate_subagent");
    expect(rows).toHaveLength(1);
    const text = String((rows[0]!.return as { text?: string }).text ?? "");
    // 修复前这里正是 provider_unavailable 的返回。
    expect(text).not.toContain("provider_unavailable");
    const payload = JSON.parse(text) as { ok: boolean; total: number; success: number; failed: number };
    expect(payload.ok).toBe(true);
    expect(payload.total).toBe(1);
    expect(payload.success).toBe(1);
    expect(payload.failed).toBe(0);
    expect(mainRequests).toBe(2);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
