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

  test("adds target=_blank to links for side panel", () => {
    const html = renderMarkdown("[GitHub 仓库](https://github.com/huyudonglove/tChrome)");
    expect(html).toContain("https://github.com/huyudonglove/tChrome");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test("strips inline on* handlers for extension CSP", () => {
    const html = renderMarkdown(`<img src="https://example.com/a.png" onerror="evil()"><a href="https://x.com" onclick="evil()">t</a>`);
    expect(html).toContain("https://example.com/a.png");
    expect(html).toContain("https://x.com");
    expect(html.toLowerCase()).not.toMatch(/\son[a-z]+\s*=/i);
  });

  test("keeps nested lists", () => {
    const html = renderMarkdown("1. **一**\n   - 细节\n2. **二**");
    expect(html).toContain("<ol>");
    expect(html).toContain("<ul>");
  });

  test("keeps multi-line SVG intact despite blank lines inside", () => {
    const svg = [
      "<svg viewBox=\"0 0 10 10\" width=\"100%\" height=\"20\" xmlns=\"http://www.w3.org/2000/svg\">",
      "  <defs>",
      "    <linearGradient id=\"g\"><stop stop-color=\"#f00\" /></linearGradient>",
      "  </defs>",
      "",
      "  <circle cx=\"5\" cy=\"5\" r=\"4\" fill=\"url(#g)\" />",
      "</svg>",
    ].join("\n");
    const html = renderMarkdown(`预览：\n\n<div style=\"padding:8px\">\n${svg}\n</div>\n\n说明文字`);
    expect(html).toContain("<svg");
    expect(html).toContain("</svg>");
    expect(html).toContain("<circle");
    expect(html).not.toContain("&lt;circle");
    // still one closed svg, not a truncated shell
    expect((html.match(/<svg/g) || []).length).toBe((html.match(/<\/svg>/g) || []).length);
  });

  test("empty input stays empty", () => {
    expect(renderMarkdown("")).toBe("");
  });
});
