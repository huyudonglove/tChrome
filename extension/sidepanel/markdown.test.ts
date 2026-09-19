import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./markdown";

describe("Markdown local panel (no filter)", () => {
  test("renders GFM structure including tables and images", () => {
    const html = renderMarkdown("# 标题\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n![本地](file:///tmp/a.png)\n\n**粗体** `code`");
    expect(html).toContain("<h1>");
    expect(html).toContain("<table>");
    expect(html).toContain("file:///tmp/a.png");
    expect(html).toContain("<strong>粗体</strong>");
  });

  test("passes through raw HTML as-is", () => {
    const html = renderMarkdown(`<div class="x">ok</div>`);
    expect(html).toContain('<div class="x">ok</div>');
  });

  test("keeps nested lists", () => {
    const html = renderMarkdown("1. **一**\n   - 细节\n2. **二**");
    expect(html).toContain("<ol>");
    expect(html).toContain("<ul>");
  });

  test("empty input stays empty", () => {
    expect(renderMarkdown("")).toBe("");
  });
});
