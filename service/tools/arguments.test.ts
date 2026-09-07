import { expect, test } from "bun:test";
import { argumentChunk, parseToolArguments } from "./arguments.ts";

test("arguments 是对象就直接用", () => {
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
  const chunk = argumentChunk({
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

test("尾逗号、围栏、单引号能修", () => {
  const trailing = parseToolArguments('{"reason":"看","affectsPage":false,}');
  expect(trailing.ok).toBe(true);
  const fenced = parseToolArguments("```json\n{\"reason\":\"看\",\"affectsPage\":false}\n```");
  expect(fenced.ok).toBe(true);
  const quotes = parseToolArguments("{'reason':'看','affectsPage':false}");
  expect(quotes.ok).toBe(true);
});

test("空字符串当空对象", () => {
  const parsed = parseToolArguments("");
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.value.reason).toBe("");
    expect(parsed.value.affectsPage).toBe(false);
  }
});

test("真坏掉的字符串仍失败", () => {
  const parsed = parseToolArguments("[object Object]");
  expect(parsed.ok).toBe(false);
});
