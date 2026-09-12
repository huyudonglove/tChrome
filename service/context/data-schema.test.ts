import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadContextModules } from "./modules.ts";
import { userText } from "./window.ts";
import { validateUserData } from "./data-schema.ts";
import schema from "./data-schema.json";
import { projectMemories } from "../memory/window.ts";
import { emptyLedger } from "../runtime/store.ts";
import type { QueryEvidence } from "./projections/queries.ts";
import type { ToolIOItem, Turn } from "../types.ts";

test("assembled User slots follow the shared data contract and preserve query record identity", () => {
  const contextModules = loadContextModules(join(import.meta.dir, "../.."));
  const names = contextModules.userOrder.map(tag => tag.slice(1));
  expect(Object.keys(schema.properties)).toEqual(names);
  expect(schema.required).toEqual(names);
  const ledger = emptyLedger("cv_01");
  ledger.userInputHistory = [{ id: "input_01", turnId: "tn_01", userInput: "检查状态", submittedAt: "2026-09-12" }];
  ledger.goal = { id: "goal_02", turnId: "tn_02", sourceCallId: "call_02", goal: "核对历史", createdAt: "2026-09-12" };
  ledger.goalHistory = [{ ...ledger.goal, id: "goal_01", turnId: "tn_01" }];
  ledger.notes = { scope: "仅核对" };
  const tool: ToolIOItem = { callId: "call_01", turnId: "tn_01", batchId: "batch_01", name: "page.get_summary", arguments: { reason: "核对状态", affectsPage: false, businessId: "task-A" }, return: { stage: "complete", totalChars: 3, text: "待处理" } };
  ledger.toolIO = [tool];
  const page = { id: "page_01", turnId: "tn_01", callId: "call_01", tab: 42, url: "https://example.com", title: "任务", description: "待处理", observedAt: "2026-09-12", toolName: tool.name };
  const turn: Turn = {
    turnId: "tn_02", conversationId: "cv_01", status: "inferring", createdAt: "2026-09-12", completedAt: null, output: null,
    input: { id: "input_02", text: "当时状态是什么？", submittedAt: "2026-09-12" },
    assembled: { baseToolsIds: [], toolIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], currentPage: page, currentTab: null, pageObservedHistory: [page] },
  };
  const query: QueryEvidence = { queryId: "query_02", turnId: "tn_02", sumId: "sum_01", module: "toolIO", intent: "核对历史状态", status: "complete", records: [{ ...tool }] };
  const memories = projectMemories({
    project: [{ memoryId: "lm_01", turnId: "tn_01", sourceCallId: "call_01", sourceConversationId: "cv_01", layer: "project", text: "保留核对依据", createdAt: "2026-09-12" }],
    conversation: [{ memoryId: "mm_01", turnId: "tn_01", sourceCallId: "call_01", layer: "conversation", text: "当时待处理", createdAt: "2026-09-12" }],
  });
  const rendered = userText({ contextModules, ledger, turn, memories, skillText: "核对方法", conversationSummaries: [{ id: "sum_01", turnId: "tn_01", tag: "状态", userRequest: "检查状态", actions: "读取详情", result: "待处理" }], currentQuery: query, queryHistory: [{ ...query, queryId: "query_01" }] });
  const chunks = rendered.split(/^#([A-Za-z][A-Za-z0-9]*)\n/gm);
  const values: Record<string, any> = {};
  for (let i = 1; i < chunks.length; i += 2) {
    const name = chunks[i]!;
    const body = chunks[i + 1]!.trim();
    values[name] = name === "skill" ? body : JSON.parse(body);
  }
  expect(validateUserData(values), JSON.stringify(validateUserData.errors)).toBe(true);
  expect(values.currentQuery.records).toEqual([tool]);
  expect(values.currentQuery.records[0]).not.toHaveProperty("content");
  const wrapped = structuredClone(values);
  wrapped.currentQuery.records = [{ id: tool.callId, turnId: tool.turnId, content: tool }];
  expect(validateUserData(wrapped)).toBe(false);
  expect(validateUserData({ ...values, unknownSlot: [] })).toBe(false);
  const unknownField = structuredClone(values);
  unknownField.userInput.unknownField = true;
  expect(validateUserData(unknownField)).toBe(false);
});
