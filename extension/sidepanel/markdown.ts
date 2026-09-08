const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Parse raw link destinations before generating any inline HTML. Never run
// Markdown replacements over an already-generated tag or attribute.
const renderInline = (text: string, links = true): string => {
  const tokens = /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*|(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|~~(.+?)~~/g;
  let result = "";
  let offset = 0;
  for (const match of text.matchAll(tokens)) {
    result += escapeHtml(text.slice(offset, match.index));
    const [raw, code, label, destination, strong, em, del] = match;
    if (code !== undefined) {
      result += `<code>${escapeHtml(code)}</code>`;
    } else if (label !== undefined && destination !== undefined) {
      const content = renderInline(label, false);
      const href = destination.trim();
      let safe = false;
      // Reject controls rather than relying on URL's silent normalization.
      if (links && !/[\u0000-\u0020\u007f]/.test(href) && /^(https?:\/\/|mailto:)/i.test(href)) {
        try {
          safe = ["http:", "https:", "mailto:"].includes(new URL(href).protocol);
        } catch { /* Invalid destinations remain text. */ }
      }
      result += safe
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${content}</a>`
        : content;
    } else {
      const tag = strong !== undefined ? "strong" : em !== undefined ? "em" : "del";
      result += `<${tag}>${renderInline(strong ?? em ?? del ?? "", links)}</${tag}>`;
    }
    offset = match.index + raw.length;
  }
  return result + escapeHtml(text.slice(offset));
};

export const renderMarkdown = (text: string) => {
  if (!text) return "";
  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;
  let codeContent: string[] = [];
  let inUl = false;
  let inOl = false;
  const closeLists = () => {
    if (inUl) { result.push("</ul>"); inUl = false; }
    if (inOl) { result.push("</ol>"); inOl = false; }
  };
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      closeLists();
      if (inCodeBlock) {
        result.push(`<pre><code>${escapeHtml(codeContent.join("\n"))}</code></pre>`);
        codeContent = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeContent.push(line);
      continue;
    }
    let processed = escapeHtml(line);
    if (!processed.trim()) { closeLists(); result.push(""); continue; }
    if (processed.startsWith("### ")) { closeLists(); result.push(`<h3>${processed.slice(4)}</h3>`); continue; }
    if (processed.startsWith("## ")) { closeLists(); result.push(`<h2>${processed.slice(3)}</h2>`); continue; }
    if (processed.startsWith("# ")) { closeLists(); result.push(`<h1>${processed.slice(2)}</h1>`); continue; }
    if (/^[\s]*[-*•]\s/.test(processed)) {
      if (!inUl) { closeLists(); result.push("<ul>"); inUl = true; }
      result.push(`<li>${processed.replace(/^[\s]*[-*•]\s/, "")}</li>`);
      continue;
    }
    if (/^[\s]*\d+[.)]\s/.test(processed)) {
      if (!inOl) { closeLists(); result.push("<ol>"); inOl = true; }
      result.push(`<li>${processed.replace(/^[\s]*\d+[.)]\s/, "")}</li>`);
      continue;
    }
    closeLists();
    processed = renderInline(line);
    result.push(`<p>${processed}</p>`);
  }
  closeLists();
  if (inCodeBlock && codeContent.length) {
    result.push(`<pre><code>${escapeHtml(codeContent.join("\n"))}</code></pre>`);
  }
  return result.join("\n");
};
