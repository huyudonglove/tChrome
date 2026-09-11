import { expect, test } from "bun:test";
import { queryRecord } from "./records.ts";
import type { ChatTool } from "../types.ts";

const args = { kind: "tool", id: "source", offset: 0, limit: 1 };
const query = (mode: string, full: string | null, extra = {}) => JSON.parse(queryRecord({ ...args, ...extra, mode }, full));

test("概览提供JSON结构及文本长度", () => {
  expect(query("inspect", '{"price":20}').structure.keys).toEqual(["price"]);
  expect(query("inspect", '[1,2]').structure.items).toBe(2);
  expect(query("inspect", 'a\nb').structure.totalLines).toBe(2);
});
test("搜索远端内容并继续翻页", () => {
  const full = "a".repeat(3000) + "目标一目标二";
  const first = query("search", full, { query: "目标" });
  expect(first.matches[0].start).toBe(3000);
  expect(first.returnedCount).toBe(1);
  expect(first.hasMore).toBe(true);
  const second = query("search", full, { query: "目标", offset: first.nextOffset });
  expect(second.matches[0].start).toBe(3003);
  expect(second.hasMore).toBe(false);
  expect(query("search", full, { query: "不存在" }).matches).toEqual([]);
});
test("按返回位置读取可重建完整记录", () => {
  const full = "abc😀中文".repeat(700);
  let offset = 0;
  let text = "";
  while (true) {
    const result = query("read", full, { offset, limit: 137 });
    text += result.text;
    if (!result.hasMore) break;
    offset = result.nextOffset;
  }
  expect(text).toBe(full);
  expect(query("read", full, { offset: full.length }).text).toBe("");
  expect(query("read", full, { offset: full.length + 1 }).ok).toBe(false);
});
test("不存在的记录和空记录分开", () => {
  expect(query("inspect", null).ok).toBe(false);
  expect(query("inspect", "").ok).toBe(true);
});

test("record.query 按模式验证参数，分页边界不混用", async () => {
  const { checkToolCalls } = await import("./schema.ts");
  const definition = (await import("./definitions/record.query.json")).default;
  const check = (extra: Record<string, unknown>) => checkToolCalls([
    { id: "query", name: "record.query", arguments: {
      reason: "回查证据", affectsPage: false, kind: "tool", id: "source", ...extra,
    } },
  ], [definition as ChatTool], ["record.query"], []).schemaOk;
  expect(check({ mode: "inspect" })).toBe(true);
  expect(check({ mode: "inspect", offset: 0 })).toBe(false);
  expect(check({ mode: "read", offset: 0, limit: 10000 })).toBe(true);
  expect(check({ mode: "read", offset: 0 })).toBe(false);
  expect(check({ mode: "read", offset: 0, limit: 10001 })).toBe(false);
  expect(check({ mode: "read", offset: 0, limit: 1, query: "a" })).toBe(false);
  expect(check({ mode: "search", offset: 0, limit: 20, query: "a" })).toBe(true);
  expect(check({ mode: "search", offset: 0, limit: 21, query: "a" })).toBe(false);
  expect(check({ mode: "search", offset: 0, limit: 1, query: "" })).toBe(false);
});
