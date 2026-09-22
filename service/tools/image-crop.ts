import { errorInfo } from "../../shared/errors.ts";
import { admitImage } from "../admission.ts";
import { readImageDataUrl, saveImage, type ImageReference } from "../images/store.ts";
import { loadLedger } from "../runtime/store.ts";
import type { BrowserHost } from "../types.ts";

export const IMAGE_TOOL_NAMES = ["image.crop"] as const;

export async function runImageTool(
  name: string,
  input: Record<string, unknown>,
  host: BrowserHost | undefined,
  dataDir: string,
  conversationId: string | undefined,
): Promise<Record<string, unknown>> {
  if (name !== "image.crop") return { ok: false, error: "unknown image tool" };
  if (!conversationId) return { ok: false, error: "image.crop 缺少会话标识" };
  if (!host) return { ok: false, error: "image.crop 需要浏览器桥" };
  try {
    const imageId = String(input.imageId ?? "").trim();
    const x = Number(input.x), y = Number(input.y), width = Number(input.width), height = Number(input.height);
    if (!imageId) return { ok: false, error: "缺 imageId" };
    if (![x, y, width, height].every((n) => Number.isFinite(n) && n >= 0) || width <= 0 || height <= 0) {
      return { ok: false, error: "需要 x、y、width、height（width/height > 0）" };
    }
    const source = findImage(dataDir, conversationId, imageId);
    if (!source) return { ok: false, error: `找不到图片 ${imageId}` };
    if (x + width > source.width || y + height > source.height) {
      return { ok: false, error: `矩形超出原图 ${source.width}×${source.height}` };
    }
    const dataUrl = readImageDataUrl(dataDir, conversationId, source);
    const result = await host.execute("image.crop_pixels", {
      dataUrl, x, y, width, height,
    }) as { ok?: boolean; dataUrl?: string; error?: string };
    if (!result?.ok || typeof result.dataUrl !== "string") {
      return { ok: false, error: String(result?.error ?? "裁切失败") };
    }
    const saved = saveImage(dataDir, conversationId, result.dataUrl);
    const view = admitImage(saved);
    return {
      ok: true,
      imageId: saved.id,
      path: saved.path,
      width: saved.width,
      height: saved.height,
      bytes: saved.bytes,
      mimeType: saved.mimeType,
      sourceImageId: source.id,
      admitted: view.mode,
      ...(view.fetchHint ? { fetchHint: view.fetchHint } : {}),
    };
  } catch (error) {
    return { ok: false, ...errorInfo(error), error: error instanceof Error ? error.message : String(error) };
  }
}

function findImage(dataDir: string, conversationId: string, imageId: string): ImageReference | null {
  const ledger = loadLedger(dataDir, conversationId);
  for (const item of ledger.toolIO) {
    for (const image of item.images ?? []) {
      if (image.id === imageId) return image;
    }
  }
  return null;
}
