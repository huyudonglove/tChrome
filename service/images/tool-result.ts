import { saveImage, type ImageReference } from "./store.ts";

/** Remove image payloads before any tool result is logged, clipped or archived. */
export function storeToolImages(dataDir: string, conversationId: string, text: string): { text: string; images: ImageReference[] } {
  if (!/data:image\/[^;,\s]+;base64,/.test(text)) return { text, images: [] };
  const images: ImageReference[] = [];
  try {
    const replace = (value: unknown): unknown => {
      if (typeof value === "string" && value.startsWith("data:image/")) {
        const reference = saveImage(dataDir, conversationId, value);
        if (!images.some(image => image.id === reference.id)) images.push(reference);
        return reference;
      }
      if (typeof value === "string" && /data:image\/[^;,\s]+;base64,/.test(value)) throw new Error("embedded image payload");
      if (Array.isArray(value)) return value.map(replace);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
      return value;
    };
    return { text: JSON.stringify(replace(JSON.parse(text))), images };
  } catch {
    // Do not fall back to the original payload on malformed or unsupported images.
    return { text: JSON.stringify({ ok: false, error: "截图图片无效或保存失败，未记录图片编码；请重新截图" }), images: [] };
  }
}
