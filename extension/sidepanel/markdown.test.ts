import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./markdown";

const link = (href: string, label = "link") =>
  `<p><a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a></p>`;

// HTMLRewriter checks actual tags/attribute boundaries; values retain entities.
async function elements(markdown: string) {
  const found: { tag: string; attrs: Record<string, string> }[] = [];
  await new HTMLRewriter().on("*", {
    element(element) {
      found.push({ tag: element.tagName, attrs: Object.fromEntries(element.attributes) });
    },
  }).transform(new Response(renderMarkdown(markdown))).text();
  return found;
}

describe("Markdown safety", () => {
  test("escapes raw HTML and both quote types", () => {
    expect(renderMarkdown(`<img src=x onerror="evil"> & '`)).toBe(
      "<p>&lt;img src=x onerror=&quot;evil&quot;&gt; &amp; &#39;</p>",
    );
  });

  test("quotes cannot break out of href", async () => {
    const href = `https://example.com/"'onmouseover='evil`;
    expect(renderMarkdown(`[link](${href})`)).toBe(
      link("https://example.com/&quot;&#39;onmouseover=&#39;evil"),
    );
    expect(await elements(`[link](${href})`)).toEqual([
      { tag: "p", attrs: {} },
      { tag: "a", attrs: { href: "https://example.com/&quot;&#39;onmouseover=&#39;evil", target: "_blank", rel: "noopener noreferrer" } },
    ]);
    expect(renderMarkdown('[link](https://example.com/" onmouseover="evil)')).toBe("<p>link</p>");
  });

  test.each([
    "javascript:evil", "JaVaScRiPt:evil", "java\tscript:evil", "java\rscript:evil",
    "\u0000javascript:evil", "data:text/html,<svg/onload=evil>", "vbscript:evil",
    "file:///etc/passwd", "chrome://settings", "//evil.example", "/relative", "#fragment",
    "javascript&#58;evil", "&#106;avascript:evil", "javascript%3Aevil", "https://",
  ])("does not link unsafe or unsupported destination %s", (href) => {
    expect(renderMarkdown(`[link](${href})`)).toBe("<p>link</p>");
  });

  test.each(["https://example.com/path", "http://example.com", "HTTPS://example.com", "mailto:me@example.com"])(
    "preserves allowed destination %s", (href) => {
      expect(renderMarkdown(`[link](${href})`)).toBe(link(href));
    },
  );

  test.each(["**bold**", "*italic*", "~~deleted~~", "`code`"])(
    "never interpolates generated %s tags into href", async (markup) => {
      const href = `https://example.com/${markup}?q="x"&v='y'`;
      const nodes = await elements(`[**label**](${href})`);
      expect(nodes.map((node) => node.tag)).toEqual(["p", "a", "strong"]);
      expect(nodes[1]!.attrs).toEqual({
        href: `https://example.com/${markup}?q=&quot;x&quot;&amp;v=&#39;y&#39;`,
        target: "_blank", rel: "noopener noreferrer",
      });
    },
  );

  test("entity-like input is not decoded into a new attribute or scheme", async () => {
    const href = "https://example.com/?x=&quot;&y=&#34;";
    expect((await elements(`[link](${href})`))[1]!.attrs.href).toBe("https://example.com/?x=&amp;quot;&amp;y=&amp;#34;");
  });

  test("raw HTML in labels remains text and unsafe links keep their label", () => {
    expect(renderMarkdown('[<img src=x onerror="evil">](javascript:evil)')).toBe(
      "<p>&lt;img src=x onerror=&quot;evil&quot;&gt;</p>",
    );
  });

  test("code never becomes a link or inline markup", () => {
    const code = '[x](javascript:evil) **bold** <img src="x">';
    const escaped = '[x](javascript:evil) **bold** &lt;img src=&quot;x&quot;&gt;';
    expect(renderMarkdown(`\`${code}\``)).toBe(`<p><code>${escaped}</code></p>`);
    expect(renderMarkdown(`\`\`\`html\n${code}\n\`\`\``)).toBe(`<pre><code>${escaped}</code></pre>`);
    expect(renderMarkdown(`\`\`\`\n${code}`)).toBe(`<pre><code>${escaped}</code></pre>`);
  });
});

describe("Markdown rendering", () => {
  test("keeps inline formatting and formatted link labels", () => {
    expect(renderMarkdown("**bold** *italic* ~~gone~~ `code`")).toBe(
      "<p><strong>bold</strong> <em>italic</em> <del>gone</del> <code>code</code></p>",
    );
    expect(renderMarkdown("[**bold**](https://example.com)")).toBe(link("https://example.com", "<strong>bold</strong>"));
    expect(renderMarkdown("**[link](https://example.com)**")).toBe(
      '<p><strong><a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a></strong></p>',
    );
  });

  test("preserves headings, lists, paragraphs and empty input", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown("# One\n## Two\n### Three\n- item\n* next\n1. first\n2) second\n\ntext")).toBe(
      "<h1>One</h1>\n<h2>Two</h2>\n<h3>Three</h3>\n<ul>\n<li>item</li>\n<li>next</li>\n</ul>\n<ol>\n<li>first</li>\n<li>second</li>\n</ol>\n\n<p>text</p>",
    );
  });
});
