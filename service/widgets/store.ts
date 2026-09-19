import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_HTML_BYTES = 200_000;
const MAX_WIDGETS = 200;

export function widgetDir(dataDir: string): string {
  return join(dataDir, "widgets");
}

export function saveWidgetHtml(dataDir: string, html: string): { id: string; url: string } | { error: string } {
  const trimmed = html.trim();
  if (!trimmed) return { error: "empty html" };
  if (Buffer.byteLength(trimmed, "utf8") > MAX_HTML_BYTES) return { error: "html too large" };
  const dir = widgetDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const id = `w_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>tChrome widget</title>
<style>
  html, body { margin: 0; padding: 12px; min-height: 100%; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #141422; color: #eee; box-sizing: border-box; }
  * { box-sizing: border-box; }
</style>
</head>
<body>
${trimmed}
</body>
</html>`;
  writeFileSync(join(dir, `${id}.html`), page, "utf8");
  try {
    const files = readdirSync(dir).filter(name => name.endsWith(".html")).sort();
    if (files.length > MAX_WIDGETS) {
      for (const name of files.slice(0, files.length - MAX_WIDGETS)) {
        try { unlinkSync(join(dir, name)); } catch { /* best effort */ }
      }
    }
  } catch { /* ignore */ }
  return { id, url: `/widget/${id}` };
}

export function readWidgetPage(dataDir: string, id: string): string | null {
  if (!/^w_[a-f0-9]{8,32}$/i.test(id)) return null;
  const path = join(widgetDir(dataDir), `${id}.html`);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}
