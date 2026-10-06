import { runtimeConfig } from "./config/runtime.ts";
import type { ImageReference } from "./images/store.ts";
import { buildBlockIndex, readBlock, type BlockIndex } from "./evidence/index.ts";

/** 原文块与检索结果共用现有内联预算，给来源和返回包装留位。 */
export const retrievalWindowChars = (): number =>
  runtimeConfig.results.inlineChars - runtimeConfig.results.pointerShellReserve;

type SourceMeta = { callId?: string; pageId?: string; path: string; name?: string };
type Admission = { mode: "inline"; text: string } | { mode: "preview"; payload: Record<string, unknown> };
type IndexOptions = { index?: BlockIndex; persistIndex?: (index: BlockIndex) => string };

/** 超量返回统一展示块目录；目录和原文都通过同一个 blockId 接口读取。 */
export function admitText(full: string, meta: SourceMeta & { index?: BlockIndex; indexPath?: string }): Admission {
  if (full.length <= runtimeConfig.results.inlineChars) return { mode: "inline", text: full };
  const index = meta.index ?? buildBlockIndex(full, { maxChars: retrievalWindowChars() });
  const directory = readBlock(index, index.rootId);
  const source = meta.pageId ? { pageId: meta.pageId } : meta.callId ? { callId: meta.callId } : {};
  return {
    mode: "preview",
    payload: {
      ok: true,
      externalized: true,
      ...source,
      ...(meta.name ? { name: meta.name } : {}),
      totalChars: full.length,
      path: meta.path,
      ...(meta.indexPath ? { indexPath: meta.indexPath } : {}),
      rootBlockId: index.rootId,
      directory,
      message: `runtime: 返回超过 ${runtimeConfig.results.inlineChars} 字符，完整原文已保存。directory 是块目录；用 evidence_search(windows=[${JSON.stringify({ ...source, blockId: index.rootId })}]) 导航，或传 keyword 查找块。kind=directory 返回子块，kind=content 返回该块完整原文。按返回的 blockId 继续读取，无需换算行号；取回结果直接内联，不会再次外置。`,
      search: "evidence_search",
    },
  };
}

/** 构建与持久化使用同一棵索引，确保窗口中的块 ID 与落盘一致。 */
export function admitReturn(full: string, meta: SourceMeta, options: IndexOptions = {}): Admission {
  if (full.length <= runtimeConfig.results.inlineChars) return { mode: "inline", text: full };
  const index = options.index ?? buildBlockIndex(full, { maxChars: retrievalWindowChars() });
  const indexPath = options.persistIndex?.(index);
  return admitText(full, { ...meta, index, ...(indexPath ? { indexPath } : {}) });
}

/** 已定位的检索结果直接内联，原文块不会再次变成目录。 */
export function admitExecution(full: string, admitted: boolean | undefined, meta: SourceMeta, options: IndexOptions = {}): Admission {
  return admitted ? { mode: "inline", text: full } : admitReturn(full, meta, options);
}

/** 图片侧的对应事实：裁切/重截不走 admitted 通道，其返回仍按入窗门槛判定。 */
const IMAGE_REFLOW_NOTE = "裁切/重截后的图片仍按入窗门槛判定。";

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
    fetchHint: `信息已降级。要细节请更精准：image_crop 裁更小矩形，或 capture_page(mode=element|rect)；${IMAGE_REFLOW_NOTE}`,
  };
}

export function deferredImageNote(deferred: Pick<ImageReference, "id" | "path" | "width" | "height" | "bytes">[]): string {
  if (!deferred.length) return "";
  const rows = deferred.map((image) => `${image.id} ${image.width}x${image.height} ${image.bytes}B`).join(", ");
  return `runtime: 图片超过入窗门槛未附带像素（${rows}）。要画面请更精准：image_crop 或 capture_page(mode=element|rect) 只取目标区域；${IMAGE_REFLOW_NOTE}`;
}
