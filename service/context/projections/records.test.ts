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
