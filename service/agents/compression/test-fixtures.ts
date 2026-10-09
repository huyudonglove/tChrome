import { join } from "node:path";
import type { LoopRecord, Provider } from "../../types.ts";
export const repoRoot = join(import.meta.dir, "../../..");
export function loop(id: string, type?: "userInput" | "interrupt"): LoopRecord {
  return { id, conversationId: "cv_test", turnId: "tn_01", createdAt: "2026-10-09", completedAt: "2026-10-09", runtime: type ? [{ id: `rt_${id}`, type, content: "修复并验证" }] : [], helm: { id: `helm_${id}`, content: "完成读取", calls: [], finish: "tool_calls" } };
}
export function model(observe?: Parameters<Provider["complete"]>[0] extends infer R ? (request: R) => void : never, count = 1): Provider {
  return { async complete(request) {
    observe?.(request);
    return { finish: "tool_calls", content: "", toolCalls: Array.from({ length: count }, (_, i) => ({ id: `call_${i}`, name: "submitLoopSummaries", arguments: { summary: "检查完成", actions: "已读取", result: "验证通过" } })), attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [] };
  } };
}
