import { expect, test } from "bun:test";
import { compactLoopIds, loopSummaryView } from "./records.ts";

test("compactLoopIds collapses consecutive ids into ranges and leaves the rest alone", () => {
  expect(compactLoopIds(["loop_01", "loop_02", "loop_03", "loop_07"])).toEqual(["loop_01–loop_03", "loop_07"]);
  expect(compactLoopIds(["loop_01", "sum_02"])).toEqual(["loop_01", "sum_02"]);
  expect(compactLoopIds([])).toEqual([]);
});

test("loopSummaryView compacts the window copy while the ledger record keeps every id", () => {
  const record = { id: "sum_01", loopIds: ["loop_01", "loop_02"], userRequest: "u", state: "r", constraints: [], pending: [], decisions: [] };
  expect(loopSummaryView([record])[0]!.loopIds).toEqual(["loop_01–loop_02"]);
  expect(loopSummaryView([record])[0]!.sumId).toBe("sum_01");
  expect(record.loopIds).toEqual(["loop_01", "loop_02"]);
});

test("loopSummaryView keeps summary fields plus traceability and drops archive-side columns", () => {
  const record = { id: "sum_02", loopIds: ["loop_01"], userRequest: "u", constraints: [], state: "s", pending: [], decisions: [],
    module: "conversationHistory" as const, level: 2, sourceIds: ["sum_01"], createdAt: "2026-10-11", from: ["sum_01"] };
  const view = loopSummaryView([record])[0]!;
  expect(view.level).toBe(2);
  expect(view.from).toEqual(["sum_01"]);
  // createdAt 是归档侧的落盘时间，摘要顺序本身已编码新旧，窗口里属零信息量字段。
  expect(JSON.stringify(view)).not.toContain("2026-10-11");
  expect("module" in view).toBe(false);
  expect("sourceIds" in view).toBe(false);
  expect("createdAt" in view).toBe(false);
});

test("loopSummaryView omits optional traceability fields when absent", () => {
  const record = { id: "sum_03", loopIds: ["loop_01"], userRequest: "u", constraints: [], state: "s", pending: [], decisions: [] };
  const view = loopSummaryView([record])[0]!;
  expect("level" in view).toBe(false);
  expect("from" in view).toBe(false);
});
