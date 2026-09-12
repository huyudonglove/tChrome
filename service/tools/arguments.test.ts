import { expect, test } from "bun:test";
import { parseToolArguments } from "./arguments.ts";

test("arguments 是对象就直接用，不补字段", () => {
  const parsed = parseToolArguments({
    reason: "填邮箱",
    affectsPage: true,
    id: "e1",
    text: "a@b.com",
  });
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.value).toEqual({
      reason: "填邮箱",
      affectsPage: true,
      id: "e1",
      text: "a@b.com",
    });
  }
});

test("流式把对象拼成字符串后还能 parse", () => {
  const chunk = JSON.stringify({
    reason: "填邮箱",
    affectsPage: true,
    id: "e1",
    text: "a@b.com",
  });
  expect(chunk).not.toContain("[object Object]");
  const parsed = parseToolArguments(chunk);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(parsed.value.id).toBe("e1");
});

test("只解析标准JSON，不猜测或修改目标文字", () => {
  for (const raw of ['{"targetText":"a,}",}', "```json\n{}\n```", "{'id':'e1'}", '"{}"']) {
    expect(parseToolArguments(raw).ok).toBe(false);
  }
  expect(parseToolArguments('{"targetText":"a,}"}')).toEqual({ok:true,value:{targetText:"a,}"}});
});

test("空字符串当空对象，不填 reason / affectsPage", () => {
  const parsed = parseToolArguments("");
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(Object.keys(parsed.value)).toEqual([]);
});

test("真坏掉的字符串仍失败", () => {
  const parsed = parseToolArguments("[object Object]");
  expect(parsed.ok).toBe(false);
});
