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
  ledger.goals = [{ parentId: null, status: "active", updatedAt: "2026-09-12", id: "goal_02", turnId: "tn_02", sourceCallId: "call_02", goal: "核对历史", createdAt: "2026-09-12" }];
  ledger.currentGoalId = "goal_02";
  ledger.goals.push({ ...ledger.goals[0]!, id: "subgoal_01", parentId: "goal_02", status: "completed", turnId: "tn_01" });
  ledger.goals.push({ ...ledger.goals[0]!, id: "goal_03", status: "cancelled" });
  ledger.goals.push({ ...ledger.goals[0]!, id: "subgoal_02", parentId: "goal_03" });
  ledger.currentGoalId = "subgoal_02";
  ledger.notes = { scope: "仅核对" };
  const tool: ToolIOItem = { callId: "call_01", turnId: "tn_01", batchId: "batch_01", name: "page.get_summary", arguments: { reason: "核对状态", businessId: "task-A" }, return: { stage: "complete", totalChars: 3, text: JSON.stringify({ ok: true, tabId: 42, title: "任务", url: "https://example.com", description: "待处理" }) } };
  ledger.toolIO = [tool];
  const page = { id: "page_01", turnId: "tn_01", callId: "call_01", tabId: 42, type: "page.get_summary", result: { ok: true, tabId: 42, title: "任务", url: "https://example.com", description: "待处理" }, observedAt: "2026-09-12" };
  const turn: Turn = { goalChanges: [],
    turnId: "tn_02", conversationId: "cv_01", status: "inferring", createdAt: "2026-09-12", completedAt: null, output: null,
    input: { id: "input_02", text: "当时状态是什么？", submittedAt: "2026-09-12" },
    assembled: { baseToolsIds: [], toolIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], currentPage: { tabId: 42, url: "https://example.com", title: "任务", description: "待处理" }, openTabs: { ok: true, windows: [] }, pageObservedHistory: [page] },
  };
  const query: QueryEvidence = { queryId: "query_02", turnId: "tn_02", sumId: "sum_01", module: "toolIO", intent: "核对历史状态", status: "complete", records: [{ ...tool }] };
  const memories = projectMemories({
    project: [{ memoryId: "lm_01", turnId: "tn_01", sourceCallId: "call_01", sourceConversationId: "cv_01", layer: "project", text: "保留核对依据", createdAt: "2026-09-12" }],
    conversation: [{ memoryId: "mm_01", turnId: "tn_01", sourceCallId: "call_01", layer: "conversation", text: "当时待处理", createdAt: "2026-09-12" }],
  });
  const rendered = userText({ contextModules, ledger, turn, memories, skillText: "核对方法", conversationSummaries: [{ id: "sum_01", turnId: "tn_01", tag: "状态", userRequest: "检查状态", actions: "读取详情", result: "待处理" }], currentQuery: query, queryHistory: [{ ...query, queryId: "query_01" }] });
  const values: Record<string, any> = {};
  const re = /<([A-Za-z][A-Za-z0-9]*)>\n[\s\S]*?\n\n内容：\n([\s\S]*?)\n<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered))) {
    const name = m[1]!, body = m[2]!;
    values[name] = name === "skill" || name === "tools" ? body : JSON.parse(body);
  }
  expect(validateUserData(values), JSON.stringify(validateUserData.errors)).toBe(true);
  expect(values.openTabs.turnId).toBe("tn_02");
  expect(values.notes).toEqual({ turnId: "tn_02", notes: { scope: "仅核对" } });
  expect(values.currentQuery.turnId).toBe("tn_02");
  expect(values.goal.currentGoalId).toBe("subgoal_02");
  expect(values.goal.goals.map((row: { id: string }) => row.id)).toEqual(["goal_02", "goal_03", "subgoal_02"]);
  expect(values.goalHistory.map((row: { id: string; status: string }) => [row.id, row.status])).toEqual([["subgoal_01", "completed"], ["goal_03", "cancelled"]]);
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
