import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserHost } from "../types.ts";
import { readImageDataUrl, saveImage, type ImageReference } from "./store.ts";

const THUMB_MAX_BYTES = 64 * 1024;

/** 入库前压一档缩略图，走 saveImage 正规入库；出库降级时可附带。 */
export async function ensureThumb(
  dataDir: string,
  conversationId: string,
  ref: ImageReference,
  host: BrowserHost | undefined,
  maxSide = 384,
): Promise<ImageReference | null> {
  const cached = loadThumbRef(dataDir, conversationId, ref.id);
  if (cached) return cached;
  if (!host || ref.bytes <= THUMB_MAX_BYTES) return null;
  try {
    const dataUrl = readImageDataUrl(dataDir, conversationId, ref);
    const shrunk = await host.execute("image.shrink", { dataUrl, maxSide }) as { ok?: boolean; dataUrl?: string };
    if (!shrunk?.ok || typeof shrunk.dataUrl !== "string") return null;
    const saved = saveImage(dataDir, conversationId, shrunk.dataUrl);
    saveThumbRef(dataDir, conversationId, ref.id, saved);
    return saved;
  } catch {
    return null;
  }
}

export function loadThumbRef(dataDir: string, conversationId: string, sourceImageId: string): ImageReference | null {
  const path = join(dataDir, "conversations", conversationId, "images", "thumbs.json");
  if (!existsSync(path)) return null;
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as Record<string, ImageReference>)[sourceImageId] ?? null;
  } catch {
    return null;
  }
}

function saveThumbRef(dataDir: string, conversationId: string, sourceImageId: string, thumb: ImageReference): void {
  const dir = join(dataDir, "conversations", conversationId, "images");
  const path = join(dir, "thumbs.json");
  const table = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, ImageReference>) : {};
  table[sourceImageId] = thumb;
  writeFileSync(path, JSON.stringify(table));
}
