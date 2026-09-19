import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

/** Local panel: render GFM (and raw HTML in the source) as-is. No sanitization. */
export function renderMarkdownInWindow(text: string, _win?: unknown): string {
  if (!text) return "";
  return marked.parse(text, { async: false }) as string;
}

export function renderMarkdown(text: string): string {
  return renderMarkdownInWindow(text);
}
