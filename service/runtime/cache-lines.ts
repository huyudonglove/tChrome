import { runtimeConfig } from "../config/runtime.ts";

/** C1: UTF-16 code units via String.length / slice. */
export const cacheLineWidth = () => runtimeConfig.results.lineWidth;

/** Split cached full text into fixed-width lines on disk (A1). */
export function wrapCachedText(text: string, width = cacheLineWidth()): string {
  if (!text) return "";
  if (width <= 0 || text.length <= width) return text;
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += width) parts.push(text.slice(i, i + width));
  return parts.join("\n");
}

/** Line metrics for externalized summaries, measured on the original body. */
export function cachedLineInfo(totalChars: number, width = cacheLineWidth()) {
  const lineWidth = width > 0 ? width : 100;
  const totalLines = totalChars <= 0 ? 0 : Math.ceil(totalChars / lineWidth);
  return { totalChars, totalLines, lineWidth };
}

export function linesOf(wrapped: string): string[] {
  return wrapped.length ? wrapped.split("\n") : [];
}

export function lineNumberAt(wrapped: string, offset: number): number {
  if (offset <= 0) return 1;
  let line = 1;
  const end = Math.min(offset, wrapped.length);
  for (let i = 0; i < end; i++) if (wrapped.charCodeAt(i) === 10) line++;
  return line;
}
