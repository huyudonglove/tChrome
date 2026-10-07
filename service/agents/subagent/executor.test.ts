import { expect, test } from "bun:test";
import { createTaskPacket, executeSubagent } from "./index.ts";
import type { CompletionResult, Provider } from "../../types.ts";

const completion = (partial: Partial<CompletionResult>): CompletionResult => ({
  finish: "stop",
  content: "",
  toolCalls: [],
  attempts: 1,
  parseOk: true,
  schemaOk: true,
  faultCode: null,
  missing: [],
  ...partial,
});

const packet = createTaskPacket({
  id: "p1",
  role: "researcher",
  objective: "只读核查一个事实",
  facts: [],
  constraints: [],
  acceptanceCriteria: [],
  dependencies: [],
});

// 缺 summary 的 evidence：正是 tn_23 端到端实跑时踩到的形状。
const missingSummary = JSON.stringify({
  taskId: "p1",
  status: "success",
  summary: "完成",
  evidence: [{ kind: "test" }],
});
const compliant = JSON.stringify({
  taskId: "p1",
  status: "success",
  summary: "完成",
  evidence: [{ kind: "test", summary: "确定性证据" }],
});

test("提示词交代 evidence 契约，模型不必靠猜 summary", async () => {
  const systemPrompts: string[] = [];
  const provider: Provider = {
    complete: async ({ messages }) => {
      systemPrompts.push(messages[0]!.content);
      return completion({ content: compliant });
    },
  };
  const result = await executeSubagent({ packet, dependencyResults: [] }, { provider });
  expect(result.status).toBe("success");
  expect(systemPrompts[0]).toContain("summary 必须是非空字符串");
});

test("格式非法时按协议纠正重问一次，第二次合规即成功且只多一次请求", async () => {
  const calls: string[] = [];
  const provider: Provider = {
    complete: async ({ messages }) => {
      calls.push(messages[messages.length - 1]!.content);
      return completion({ content: calls.length === 1 ? missingSummary : compliant });
    },
  };
  const result = await executeSubagent({ packet, dependencyResults: [] }, { provider });
  expect(result.status).toBe("success");
  expect(result.evidence[0]!.summary).toBe("确定性证据");
  expect(calls).toHaveLength(2);
  // 重问消息要带 selfRepair 标记与具体 fault，模型才知道改哪里。
  const repair = JSON.parse(calls[1]!) as { selfRepair?: boolean; fault?: string };
  expect(repair.selfRepair).toBe(true);
  expect(repair.fault).toContain("evidence[0].summary");
});

test("两次都不合规才判失败，errors 保留具体字段", async () => {
  const provider: Provider = { complete: async () => completion({ content: missingSummary }) };
  const result = await executeSubagent({ packet, dependencyResults: [] }, { provider });
  expect(result.status).toBe("failed");
  expect(result.summary).toBe("Subagent 输出或执行协议无效");
  expect(result.errors?.[0]).toContain("evidence[0].summary");
});
