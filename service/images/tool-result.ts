import { saveImage, type ImageReference } from "./store.ts";

export function storeToolImages(
  dataDir: string,
  conversationId: string,
  text: string,
  source: { tool?: string; callId?: string; tabId?: number; url?: string; element?: string } = {},
): { text: string; images: ImageReference[] } {
  if (!/data:image\/[^;,\s]+;base64,/.test(text)) return { text, images: [] };
  const images: ImageReference[] = [];
  try {
    const parsed = JSON.parse(text) as unknown;
    const replace = (value: unknown): unknown => {
      if (typeof value === "string" && /^data:image\/[^;,\s]+;base64,/.test(value)) {
        const reference = saveImage(dataDir, conversationId, value, source);
        if (!images.some(image => image.id === reference.id)) images.push(reference);
        return { id: reference.id, path: reference.path, mimeType: reference.mimeType, width: reference.width, height: reference.height, bytes: reference.bytes };
      }
      if (Array.isArray(value)) return value.map(replace);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
      return value;
    };
    return { text: JSON.stringify(replace(parsed)), images };
  } catch {
    // Do not fall back to the original payload on malformed or unsupported images.
    return { text: JSON.stringify({ ok: false, error: "截图图片无效或保存失败，未记录图片编码；请重新截图" }), images: [] };
  }
}
