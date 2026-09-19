import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

/**
 * CommonMark ends some HTML blocks at blank lines, which splits multi-line <svg>/<div>.
 * Stash whole islands as single-line custom tags, parse markdown, then restore.
 */
function extractHtmlIslands(source: string): { text: string; islands: string[] } {
  const islands: string[] = [];
  const stash = (html: string) => {
    const idx = islands.length;
    islands.push(html);
    return `<tchrome-island data-id="${idx}"></tchrome-island>`;
  };

  let text = source;
  text = text.replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, (m) => stash(m));
  text = text.replace(/<table\b[\s\S]*?<\/table\s*>/gi, (m) => stash(m));

  // Balanced <div> blocks (placeholders are not divs, so they stay opaque).
  let guard = 0;
  while (guard++ < 500) {
    const open = /<div\b[^>]*>/i.exec(text);
    if (!open) break;
    const start = open.index;
    const tagRe = /<\/?div\b[^>]*>/gi;
    tagRe.lastIndex = start;
    let depth = 0;
    let end = -1;
    let tag: RegExpExecArray | null;
    while ((tag = tagRe.exec(text))) {
      depth += tag[0].startsWith("</") ? -1 : 1;
      if (depth === 0) {
        end = tag.index + tag[0].length;
        break;
      }
    }
    if (end < 0) break;
    text = text.slice(0, start) + stash(text.slice(start, end)) + text.slice(end);
  }
  return { text, islands };
}

function restoreHtmlIslands(html: string, islands: string[]): string {
  let out = html;
  for (let pass = 0; pass < islands.length + 3; pass++) {
    const next = out.replace(/<tchrome-island data-id="(\d+)"\s*><\/tchrome-island>/g, (_m, idx: string) => islands[Number(idx)] ?? "");
    if (next === out) break;
    out = next;
  }
  // marked may wrap island tags in <p>; unwrap invalid p > block containers
  return out
    .replace(/<p>\s*(<tchrome-island[\s\S]*?<\/tchrome-island>)\s*<\/p>/g, "$1")
    .replace(/<p>\s*(<(?:div|svg|table)\b[\s\S]*?<\/(?:div|svg|table)>)\s*<\/p>/g, "$1");
}

/** Local panel: GFM → HTML. Protect raw HTML islands; strip only inline on* (MV3 CSP). */
export function renderMarkdownInWindow(text: string, _win?: unknown): string {
  if (!text) return "";
  const { text: md, islands } = extractHtmlIslands(text);
  const raw = marked.parse(md, { async: false }) as string;
  const restored = restoreHtmlIslands(raw, islands);
  const cleaned = restored.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  return cleaned.replace(/<a\b([^>]*)>/gi, (_m, attrs: string) => {
    const next = /(^|\s)target\s*=/i.test(attrs) ? attrs : `${attrs} target="_blank"`;
    const withRel = /(^|\s)rel\s*=/i.test(next) ? next : `${next} rel="noopener noreferrer"`;
    return `<a${withRel}>`;
  });
}

export function renderMarkdown(text: string): string {
  return renderMarkdownInWindow(text);
}
