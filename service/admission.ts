import { runtimeConfig } from "./config/runtime.ts";
import type { ImageReference } from "./images/store.ts";

/** 入窗门禁：超限载荷降级为摘要/指针，并带回告——要细节请更精准，取回再过同一门禁。 */
export function admitText(
  full: string,
  meta: { callId?: string; pageId?: string; path: string; name?: string },
): { mode: "inline"; text: string } | { mode: "preview"; payload: Record<string, unknown> } {
  const { inlineChars, previewChars, lineWidth, searchContextChars } = runtimeConfig.results;
  if (full.length <= inlineChars) return { mode: "inline", text: full };
  const totalLines = Math.ceil(full.length / lineWidth);
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
      preview: full.slice(0, previewChars),
      path: meta.path,
      message: `runtime: 内容超过 ${inlineChars} 字符，已降级为摘要指针（preview 前 ${previewChars} 字，全文 ${totalLines} 行）。要细节请更精准：evidence.search(windows=[{${locate},keyword|startLine}])，可一次带多个窗口；取回结果会再过同一门禁。`,
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
