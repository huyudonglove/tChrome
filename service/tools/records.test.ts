import { expect, test } from "bun:test";
import { queryRecord } from "./records.ts";

const args = { kind: "tool", id: "source", offset: 0, limit: 1 };
const query = (name: string, full: string | null, extra = {}) => JSON.parse(queryRecord(name, { ...args, ...extra }, full));

test("概览提供JSON结构及文本长度", () => {
  expect(query("record.inspect", '{"price":20}').structure.keys).toEqual(["price"]);
  expect(query("record.inspect", '[1,2]').structure.items).toBe(2);
  expect(query("record.inspect", 'a\nb').structure.totalLines).toBe(2);
});
test("搜索远端内容并继续翻页", () => {
  const full = "a".repeat(3000) + "目标一目标二";
  const first = query("record.search", full, { query: "目标" });
  expect(first.matches[0].start).toBe(3000);
  expect(first.returnedCount).toBe(1);
  expect(first.hasMore).toBe(true);
  const second = query("record.search", full, { query: "目标", offset: first.nextOffset });
  expect(second.matches[0].start).toBe(3003);
  expect(second.hasMore).toBe(false);
  expect(query("record.search", full, { query: "不存在" }).matches).toEqual([]);
});
test("按返回位置读取可重建完整记录", () => {
  const full = "abc😀中文".repeat(700);
  let offset = 0;
  let text = "";
  while (true) {
    const result = query("record.read", full, { offset, limit: 137 });
    text += result.text;
    if (!result.hasMore) break;
    offset = result.nextOffset;
  }
  expect(text).toBe(full);
  expect(query("record.read", full, { offset: full.length }).text).toBe("");
  expect(query("record.read", full, { offset: full.length + 1 }).ok).toBe(false);
});
test("不存在的记录和空记录分开", () => {
  expect(query("record.inspect", null).ok).toBe(false);
  expect(query("record.inspect", "").ok).toBe(true);
});
