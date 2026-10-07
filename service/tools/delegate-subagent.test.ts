import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "../types.ts";
import { executeTool, type ExecuteInput } from "./execute.ts";

const baseInput = (): Record<string, unknown> => ({
  dataDir: mkdtempSync(join(tmpdir(), "tchrome-delegate-")),
  browserNames: [],
  lookup: { unusedTools: [], knownTools: [], enabledTools: [] },
  provider: { complete: async () => ({ finish: "stop", content: "{}" }) } as unknown as Provider,
});

const delegate = (extra: Record<string, unknown>): ExecuteInput =>
  ({ name: "delegate_subagent", arguments: { packets: [], reason: "委派" }, ...baseInput(), ...extra } as unknown as ExecuteInput);

test("没有任何 packet 成功时 ok 为 false", async () => {
  const execution = await executeTool(delegate({}));
  const payload = JSON.parse(execution.text) as { ok: boolean; total: number; success: number };
  expect(payload.ok).toBe(false);
  expect(payload.total).toBe(0);
  expect(payload.success).toBe(0);
});

test("全部 packet 成功时 ok 才为 true", async () => {
  const execution = await executeTool(delegate({
    arguments: {
      packets: [{ id: "a", role: "researcher", objective: "查证", facts: [], constraints: [], acceptanceCriteria: [], dependencies: [] }],
      reason: "委派",
    },
    provider: {
      complete: async () => ({
        finish: "stop",
        content: JSON.stringify({ taskId: "a", status: "success", summary: "完成", evidence: [] }),
      }),
    } as unknown as Provider,
  }));
  const payload = JSON.parse(execution.text) as { ok: boolean; success: number; total: number };
  expect(payload.ok).toBe(true);
  expect(payload.total).toBe(1);
  expect(payload.success).toBe(1);
});

test("单个 packet 失败时给出 subagent_failed 故障码", async () => {
  const execution = await executeTool(delegate({
    arguments: {
      packets: [{ id: "a", role: "researcher", objective: "查证", facts: [], constraints: [], acceptanceCriteria: [], dependencies: [] }],
      reason: "委派",
    },
    provider: {
      complete: async () => ({ finish: "stop", content: JSON.stringify({ taskId: "a", status: "failed", summary: "失败", evidence: [] }) }),
    } as unknown as Provider,
  }));
  const payload = JSON.parse(execution.text) as { ok: boolean; faultCode: string; failed: number; total: number };
  expect(payload.ok).toBe(false);
  expect(payload.faultCode).toBe("subagent_failed");
  expect(payload.total).toBe(1);
  expect(payload.failed).toBe(1);
});

test("部分 packet 失败时给出 subagent_partial_failure 与逐项计数", async () => {
  let call = 0;
  const execution = await executeTool(delegate({
    arguments: {
      packets: [
        { id: "a", role: "researcher", objective: "查证", facts: [], constraints: [], acceptanceCriteria: [], dependencies: [] },
        { id: "b", role: "implementer", objective: "实现", facts: [], constraints: [], acceptanceCriteria: [], dependencies: ["a"] },
      ],
      reason: "委派",
    },
    provider: {
      complete: async () => (++call === 1
        ? { finish: "stop", content: JSON.stringify({ taskId: "a", status: "success", summary: "完成", evidence: [] }) }
        : { finish: "stop", content: JSON.stringify({ taskId: "b", status: "failed", summary: "失败", evidence: [] }) }),
    } as unknown as Provider,
  }));
  const payload = JSON.parse(execution.text) as { ok: boolean; faultCode: string; message: string; total: number; success: number; failed: number; blocked: number };
  expect(payload.ok).toBe(false);
  expect(payload.faultCode).toBe("subagent_partial_failure");
  expect(payload.total).toBe(2);
  expect(payload.success).toBe(1);
  expect(payload.failed).toBe(1);
  expect(payload.blocked).toBe(0);
  expect(payload.message).toContain("部分");
});
