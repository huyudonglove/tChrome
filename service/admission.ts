import { runtimeConfig } from "./config/runtime.ts";
import type { ImageReference } from "./images/store.ts";
import { buildBlockIndex, expandBlock, type BlockIndex } from "./evidence/index.ts";

/** 原文块与检索结果共用现有内联预算，给来源和返回包装留位。 */
export const retrievalWindowChars = (): number =>
  runtimeConfig.results.inlineChars - runtimeConfig.results.pointerShellReserve;

type SourceMeta = { callId?: string; pageId?: string; path: string; name?: string };
type Admission = { mode: "inline"; text: string } | { mode: "preview"; payload: Record<string, unknown> };
type IndexOptions = { index?: BlockIndex; persistIndex?: (index: BlockIndex) => string };

// Execution diagnostics stay visible even when the result body is stored outside the window.
// Copy supplied values only: admission must never infer or manufacture tool success.
const STATUS_FIELDS = ["ok", "faultCode", "error", "message", "recovery", "details", "detail", "status", "exitCode", "signal", "passed", "errorCount", "warningCount", "candidates", "partial", "truncated", "truncations", "skipped", "skippedCount", "errors", "failedFrameCount", "lastError", "failureStage", "detachReason"] as const;
const ITEM_ID_FIELDS = ["path", "url", "id", "name", "index", "startLine", "endLine"] as const;
function executionStatus(value: unknown, item = false): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const fields = item ? [...STATUS_FIELDS, ...ITEM_ID_FIELDS] : STATUS_FIELDS;
  const status = Object.fromEntries(fields.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]));
  if (Array.isArray(record.results)) status.results = record.results.map(result => executionStatus(result, true));
  return status;
}

function visibleExecutionStatus(full: string): Record<string, unknown> {
  try {
    return executionStatus(JSON.parse(full));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return {};
  }
}

/** 超量返回统一展示块目录；目录和原文都通过同一个 blockId 接口读取。 */
export function admitText(full: string, meta: SourceMeta & { index?: BlockIndex; indexPath?: string }): Admission {
  if (full.length <= runtimeConfig.results.inlineChars) return { mode: "inline", text: full };
  const index = meta.index ?? buildBlockIndex(full, { maxChars: retrievalWindowChars() });
  const directory = expandBlock(index, index.rootId);
  const source = meta.pageId ? { pageId: meta.pageId } : meta.callId ? { callId: meta.callId } : {};
  return {
    mode: "preview",
    payload: {
      ...visibleExecutionStatus(full),
      externalized: true,
      ...source,
      ...(meta.name ? { name: meta.name } : {}),
      totalChars: full.length,
      path: meta.path,
      ...(meta.indexPath ? { indexPath: meta.indexPath } : {}),
      rootBlockId: index.rootId,
      directory,
      externalizationHint: `runtime: 返回超过 ${runtimeConfig.results.inlineChars} 字符，完整原文已保存。directory 已附根目录；目录自身的 blockId 是当前节点，下一步从 children[].blockId 选择子块，用 evidence_search 传相同来源和该 blockId 读取。已知符号或关键字时直接传 keyword 定位。kind=directory 返回目录及子块信息，kind=content 才返回该块完整原文。无需换算行号；取回结果直接内联，不会再次外置。`,
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

/**
 * 工具返回图片时的确定性事实：按字节门槛，同一批图片在下一次请求要么附带像素、要么只留元数据。
 * 明确写出来，模型就不必靠反复截图去猜自己到底有没有看到画面。
 */
export function imageAttachmentNote(
  images: Pick<ImageReference, "id" | "bytes">[],
  observations: { id: string; type: string }[] = [],
): string {
  if (!images.length) return "";
  const { inline, deferred } = admitImages(images);
  const ids = (rows: Pick<ImageReference, "id">[]): string => rows.map((row) => row.id).join(" ");
  const parts = [
    inline.length ? `附带像素 ${inline.length} 张（${ids(inline)}）` : "",
    deferred.length ? `未附带像素 ${deferred.length} 张（${ids(deferred)}）` : "",
  ].filter(Boolean);
  const detail = deferred.length ? `要画面请更精准：image_crop 或 capture_page(mode=element|rect)。${IMAGE_REFLOW_NOTE}` : "";
  // 像素只在附带它的那一次请求里可见，过后只剩路径：当场写下画面结论，否则下一轮只能重截。
  const record = inline.length
    ? "像素只在本次请求可见，过后只剩路径：请用 observation_write 记下画面结论（画面是什么、与上一次相比有无变化），不要复制原文或复述工具返回。"
    : "";
  const seen = inline.length && observations.length
    ? `本轮已有观察：${observations.slice(-6).map((row) => `${row.id}(${row.type})`).join("、")}；先读它们再决定是否重截。`
    : "";
  return `runtime: 本批图片 ${parts.join("，")}。${detail}${record}${seen}`;
}
