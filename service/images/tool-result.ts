import { saveImage, type ImageReference } from "./store.ts";

export function storeToolImages(
  dataDir: string,
  conversationId: string,
  text: string,
  source: { tool?: string; callId?: string; tabId?: number; url?: string; element?: string; tabTitle?: string } = {},
): { text: string; images: ImageReference[]; imagesError?: string } {
  if (!/data:image\/(?:png|jpeg);base64,/.test(text)) return { text, images: [] };
  const images: ImageReference[] = [];
  try {
    const parsed = JSON.parse(text) as unknown;
    const replace = (value: unknown): unknown => {
      if (typeof value === "string" && /^data:image\/(?:png|jpeg);base64,/.test(value)) {
        const reference = saveImage(dataDir, conversationId, value, source);
        if (!images.some(image => image.id === reference.id)) images.push(reference);
        return { id: reference.id, path: reference.path, mimeType: reference.mimeType, width: reference.width, height: reference.height, bytes: reference.bytes };
      }
      if (Array.isArray(value)) return value.map(replace);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
      return value;
    };
    return { text: JSON.stringify(replace(parsed)), images };
  } catch (error) {
    return { text, images: [], imagesError: error instanceof Error ? error.message : String(error) };
  }
}
