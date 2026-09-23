import { expect, test } from "bun:test";
import { parseToolArguments, unwrapStringArrayField } from "./arguments.ts";

test("arguments 是对象就直接用，不补字段", () => {
  const parsed = parseToolArguments({
    reason: "填邮箱",
    id: "e1",
    text: "a@b.com",
  });
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.value).toEqual({
      reason: "填邮箱",
      id: "e1",
      text: "a@b.com",
    });
  }
});

test("流式把对象拼成字符串后还能 parse", () => {
  const chunk = JSON.stringify({
    reason: "填邮箱",
    id: "e1",
    text: "a@b.com",
  });
  expect(chunk).not.toContain("[object Object]");
  const parsed = parseToolArguments(chunk);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(parsed.value.id).toBe("e1");
});

test("共用拯救格式：围栏、尾逗号、结构单引号只修外壳", () => {
  expect(parseToolArguments('```json\n{"id":"e1"}\n```')).toEqual({ ok: true, value: { id: "e1" } });
  expect(parseToolArguments('{"id":"e1",}')).toEqual({ ok: true, value: { id: "e1" } });
  expect(parseToolArguments("{'id':'e1'}")).toEqual({ ok: true, value: { id: "e1" } });
  // Content strings are not rewritten; invalid JSON still fails.
  expect(parseToolArguments("[object Object]").ok).toBe(false);
  expect(parseToolArguments('"{}"').ok).toBe(false);
});

test("空字符串当空对象，不填 reason / execution", () => {
  const parsed = parseToolArguments("");
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(Object.keys(parsed.value)).toEqual([]);
});

test("真坏掉的字符串仍失败", () => {
  const parsed = parseToolArguments("[object Object]");
  expect(parsed.ok).toBe(false);
});

test("数组字段被再编码成字符串时拆一层", () => {
  const args = { summaries: JSON.stringify([{ turnId: "tn_01" }]) };
  unwrapStringArrayField(args, "summaries");
  expect(args.summaries).toEqual([{ turnId: "tn_01" }]);
  unwrapStringArrayField(args, "summaries");
  expect(args.summaries).toEqual([{ turnId: "tn_01" }]);
  const stillString = { summaries: "not-json" };
  unwrapStringArrayField(stillString, "summaries");
  expect(stillString.summaries).toBe("not-json");
  const objectString = { summaries: JSON.stringify({ turnId: "tn_01" }) };
  unwrapStringArrayField(objectString, "summaries");
  expect(objectString.summaries).toBe(JSON.stringify({ turnId: "tn_01" }));
});
