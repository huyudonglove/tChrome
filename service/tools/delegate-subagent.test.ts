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
