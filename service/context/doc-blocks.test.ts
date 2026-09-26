import { test, expect } from "bun:test";
import { fence, replaceFencedBlock, replaceFencedSection } from "./doc-blocks.ts";

// 模拟真实结构：块正文里含嵌套围栏（带 info string），只有外层裸 ``` 能界定块尾。
const INNER = [
  "网页观察与操作",
  "",
  "```text",
  "capture_page(mode=element)",
  "```",
  "",
  "再补一段",
  "",
  "尾部之后的段落",
].join("\n");
function doc() {
  return [
    "# 样例",
    "",
    "```",
    "<skill>",
    INNER,
    "尾部之后的段落",
    "```",
    "",
    "## 下一节",
    "",
    "```json",
    "{}",
    "```",
    "",
  ].join("\n");
}

test("块正文含嵌套围栏时，按围栏栈整体替换", () => {
  const out = replaceFencedBlock(doc(), "<skill>", "<skill>\n新内容\n</skill>");
  expect(out).toBe([
    "# 样例",
    "",
    "```",
    "<skill>",
    "新内容",
    "</skill>",
    "```",
    "",
    "## 下一节",
    "",
    "```json",
    "{}",
    "```",
    "",
  ].join("\n"));
  expect(out).not.toContain("capture_page");
  expect(out).toContain("## 下一节");
});

test("重复执行结果稳定（幂等）", () => {
  const body = "<skill>\n正文含示例：\n```text\ncapture_page(mode=element)\n```\n</skill>";
  const once = replaceFencedBlock(doc(), "<skill>", body);
  const twice = replaceFencedBlock(once, "<skill>", body);
  expect(twice).toBe(once);
});

test("换更长内容不会累积旧尾巴", () => {
  const first = replaceFencedBlock(doc(), "<skill>", "<skill>\n第一版\n</skill>");
  const second = replaceFencedBlock(first, "<skill>", "<skill>\n第二版更长的内容\n</skill>");
  expect(second).toContain("第二版更长的内容");
  expect(second).not.toContain("第一版");
  expect(second.match(/<skill>/g)?.length).toBe(1);
  expect(second.match(/<\/skill>/g)?.length).toBe(1);
});

test("块首不存在时抛错，不静默产出半成品", () => {
  expect(() => replaceFencedBlock(doc(), "<nope>", "x")).toThrow();
});

test("嵌套围栏未闭合时抛错", () => {
  const broken = ["# 样例", "", "```", "<skill>", "```text", "x", "", "```", ""].join("\n");
  expect(() => replaceFencedBlock(broken, "<skill>", "x")).toThrow();
});

test("replaceFencedSection 按标题锚定段落，保留下一段标题", () => {
  const text = ["# 样例", "", "## System（10 字符）", "", "```text", "aaa", "```", "", "## User（5 字符）", "", "```text", "bbb", "```", ""].join("\n");
  const out = replaceFencedSection(text, "## System（", "## System（3 字符）\n\n" + fence("text", "ccc"), "## User（");
  expect(out).toContain("## System（3 字符）");
  expect(out).not.toContain("aaa");
  expect(out).toContain("## User（5 字符）");
  const tail = replaceFencedSection(text, "## User（", "## User（2 字符）\n\n" + fence("text", "dd"));
  expect(tail).not.toContain("bbb");
  expect(tail).toContain("## System（10 字符）");
  expect(replaceFencedSection(text, "## 无（", "x", "## User（")).toBe(text);
});

test("fence 仍按原样包裹", () => {
  expect(fence("json", "{}")).toBe("```json\n{}\n```");
});
