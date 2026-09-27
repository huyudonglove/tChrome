import { runtimeConfig } from "./config/runtime.ts";
import type { ImageReference } from "./images/store.ts";

const LIST_FIELDS = ["results", "matches", "items", "regions", "elements", "windows", "frames", "entries"] as const;

/** 单条结果的紧凑标签：优先给出可定位信息（路径 + 行号区间 / 命中行）。 */
function labelItem(item: unknown): string | null {
  if (typeof item === "string") return item.slice(0, 40);
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;
  if (typeof rec.path === "string") {
    const base = rec.path.split("/").pop() ?? rec.path;
    if (typeof rec.startLine === "number") {
      const range = rec.endLine === rec.startLine ? `${rec.startLine}` : `${rec.startLine}-${rec.endLine}`;
      const total = typeof rec.totalLines === "number" ? `/${rec.totalLines}` : "";
      return `${base}:${range}${total}`;
    }
    if (typeof rec.line === "number") return `${base}:${rec.line}`;
    return base;
  }
  if (typeof rec.line === "number") return `line ${rec.line}`;
  return null;
}

/** 结构化摘要：从超限 JSON 里抽出可行动事实（路径、行号区间、条目数、错误码），供外置指针直接可读。无法解析出事实时返回空串，调用方回退原文切片。 */
export function summarizePayload(full: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(full);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const rec = parsed as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof rec.toolName === "string") parts.push(`tool=${rec.toolName}`);
  if (typeof rec.faultCode === "string") parts.push(`faultCode=${rec.faultCode}`);
  if (rec.ok === false) parts.push("ok=false");
  if (typeof rec.truncated === "boolean" && rec.truncated) parts.push("truncated=true");
  if (typeof rec.scannedFiles === "number") parts.push(`scannedFiles=${rec.scannedFiles}`);
  if (typeof rec.scannedEntries === "number") parts.push(`scannedEntries=${rec.scannedEntries}`);
  for (const field of LIST_FIELDS) {
    const value = rec[field];
    if (!Array.isArray(value) || value.length === 0) continue;
    const labels = value.map(labelItem).filter((x): x is string => x !== null);
    const uniq = [...new Set(labels)];
    parts.push(`${field}×${value.length}${uniq.length ? `: ${uniq.slice(0, 4).join(", ")}${uniq.length > 4 ? " …" : ""}` : ""}`);
  }
  if (typeof rec.message === "string") parts.push(`message=${rec.message.slice(0, 80)}`);
  if (!parts.length) return "";
  const limit = runtimeConfig.results.summaryChars;
  let summary = parts.join("; ");
  if (summary.length > limit) summary = `${summary.slice(0, Math.max(0, limit - 1))}…`;
  return summary;
}

/** 入窗门禁：超限载荷降级为摘要/指针，并带回告——要细节请更精准，取回再过同一门禁。 */
export function admitText(
  full: string,
  meta: { callId?: string; pageId?: string; path: string; name?: string },
): { mode: "inline"; text: string } | { mode: "preview"; payload: Record<string, unknown> } {
  const { inlineChars, previewChars, lineWidth, searchContextChars } = runtimeConfig.results;
  if (full.length <= inlineChars) return { mode: "inline", text: full };
  const totalLines = Math.ceil(full.length / lineWidth);
  const summary = summarizePayload(full);
  const structured = summary.length > 0;
  const locate = meta.pageId ? `pageId=${meta.pageId}` : `callId=${meta.callId ?? ""}`;
  return {
    mode: "preview",
    payload: {
      ok: true,
      externalized: true,
      ...(meta.callId ? { callId: meta.callId } : {}),
      ...(meta.pageId ? { pageId: meta.pageId } : {}),
      ...(meta.name ? { name: meta.name } : {}),
      totalChars: full.length,
      totalLines,
      lineWidth,
      ...(structured ? { summary } : {}),
      preview: structured ? summary : full.slice(0, previewChars),
      path: meta.path,
      message: structured
        ? `runtime: 内容超过 ${inlineChars} 字符，已降级为摘要指针（summary 为结构化摘要，preview 同为该摘要；全文 ${totalLines} 行）。要细节请更精准：evidence.search(windows=[{${locate},keyword|startLine}])，可一次带多个窗口；取回结果会再过同一门禁。`
        : `runtime: 内容超过 ${inlineChars} 字符，已降级为摘要指针（preview 前 ${previewChars} 字，全文 ${totalLines} 行）。要细节请更精准：evidence.search(windows=[{${locate},keyword|startLine}])，可一次带多个窗口；取回结果会再过同一门禁。`,
      search: "evidence.search",
    },
  };
}

/** 图片门禁：小图随批附带像素；过大只保留元数据。 */
export function admitImages<T extends Pick<ImageReference, "bytes">>(images: T[]): { inline: T[]; deferred: T[] } {
  const limit = runtimeConfig.results.imageInlineBytes;
  const inline: T[] = [];
  const deferred: T[] = [];
  for (const image of images) (image.bytes <= limit ? inline : deferred).push(image);
  return { inline, deferred };
}

/** 单图门禁：小图 inline，大图 ref 并给出精准取用提示。 */
export function admitImage(image: ImageReference): { mode: "inline" | "ref"; fetchHint: string } {
  const { inline } = admitImages([image]);
  if (inline.length) return { mode: "inline", fetchHint: "" };
  return {
    mode: "ref",
    fetchHint: "信息已降级。要细节请更精准：image.crop 裁更小矩形，或 capture_page(mode=element|rect)；取回结果仍会经过同一门禁。",
  };
}

export function deferredImageNote(deferred: Pick<ImageReference, "id" | "path" | "width" | "height" | "bytes">[]): string {
  if (!deferred.length) return "";
  const rows = deferred.map((image) => `${image.id} ${image.width}x${image.height} ${image.bytes}B`).join(", ");
  return `runtime: 图片超过入窗门槛未附带像素（${rows}）。要画面请更精准：image.crop 或 capture_page(mode=element|rect) 只取目标区域；取回结果会再过同一门禁。`;
}
