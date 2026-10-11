import { expect, test } from "bun:test";
import { compactLoopIds, dateOnly, loopSummaryView } from "./records.ts";

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

test("loopSummaryView keeps summary fields plus traceability and swaps the archive timestamp for a day-granularity date", () => {
  // 本地时间构造：投影与断言都不依赖运行环境时区。
  const createdAt = new Date(2026, 9, 11, 8, 30).toISOString();
  const record = { id: "sum_02", loopIds: ["loop_01"], userRequest: "u", constraints: [], state: "s", pending: [], decisions: [],
    module: "conversationHistory" as const, level: 2, sourceIds: ["sum_01"], createdAt, from: ["sum_01"] };
  const view = loopSummaryView([record])[0]!;
  expect(view.level).toBe(2);
  expect(view.from).toEqual(["sum_01"]);
  // 归档时间戳只留到天：完整时刻在窗口里没有消费方，粗粒度日期足够界定历史跨度。
  expect(view.date).toBe("2026-10-11");
  expect(JSON.stringify(view)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  expect("module" in view).toBe(false);
  expect("sourceIds" in view).toBe(false);
  expect("createdAt" in view).toBe(false);
});

test("dateOnly keeps day granularity in the local time zone and ignores non-timestamps", () => {
  // 本地时间构造，断言不依赖运行环境时区。
  expect(dateOnly(new Date(2026, 9, 11, 8, 30).toISOString())).toBe("2026-10-11");
  expect(dateOnly("2026-10-11")).toBe("2026-10-11");
  expect(dateOnly("now")).toBeUndefined();
  expect(dateOnly("")).toBeUndefined();
  expect(dateOnly(undefined)).toBeUndefined();
});

test("loopSummaryView omits optional traceability fields when absent", () => {
  const record = { id: "sum_03", loopIds: ["loop_01"], userRequest: "u", constraints: [], state: "s", pending: [], decisions: [] };
  const view = loopSummaryView([record])[0]!;
  expect("level" in view).toBe(false);
  expect("from" in view).toBe(false);
  expect("date" in view).toBe(false);
});
