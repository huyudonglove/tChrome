import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allocateRecordId, idPrefix } from "../runtime/ids.ts";
import { appendAsset, imageSummary } from "../assets/catalog.ts";

export interface ImageReference {
  id: string;
  path: string;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
}

interface StoredImage { hash: string; ref: ImageReference }
type ImageIndex = Record<string, StoredImage>;
const shortId = new RegExp(`^${idPrefix("image")}[0-9]{2,}$`);

const MAX_BYTES = 20 * 1024 * 1024;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function fail(message: string): never { throw new Error(`image: ${message}`); }

function dimensions(bytes: Buffer, mimeType: string): { width: number; height: number } {
  if (mimeType === "image/png") {
    if (bytes.length < 45 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") fail("invalid PNG signature");
    let offset = 8;
    let width = 0;
    let height = 0;
    let hasData = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (offset + length + 12 > bytes.length) fail("truncated PNG chunk");
      if (offset === 8) {
        if (type !== "IHDR" || length !== 13) fail("invalid PNG header");
        width = bytes.readUInt32BE(offset + 8);
        height = bytes.readUInt32BE(offset + 12);
      } else if (type === "IHDR") fail("duplicate PNG header");
      if (type === "IDAT") hasData = true;
      offset += length + 12;
      if (type === "IEND") {
        if (length !== 0 || offset !== bytes.length || !hasData || !width || !height) fail("invalid PNG structure");
        return { width, height };
      }
    }
    fail("missing PNG end");
  }
  if (mimeType !== "image/jpeg") fail("unsupported image type");
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) fail("invalid JPEG signature");
  let offset = 2;
  let size: { width: number; height: number } | undefined;
  while (offset < bytes.length - 2) {
    if (bytes[offset++] !== 0xff) fail("invalid JPEG marker");
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || offset + 2 > bytes.length) fail("truncated JPEG header");
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length - 2) fail("invalid JPEG segment");
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) fail("invalid JPEG frame");
      size = { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    if (marker === 0xda) {
      if (!size?.width || !size.height) fail("missing JPEG dimensions");
      return size;
    }
    offset += length;
  }
  return fail("missing JPEG scan");
}

function directory(dataDir: string, cvId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(cvId)) fail("invalid conversation id");
  const conversations = join(dataDir, "conversations");
  const conversation = join(conversations, cvId);
  const images = join(conversation, "images");
  for (const path of [conversations, conversation, images]) {
    if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) fail("invalid image directory");
  }
  return images;
}

function readIndex(dir: string): ImageIndex {
  const path = join(dir, "index.json");
  if (!existsSync(path)) return {};
  if (!lstatSync(path).isFile()) fail("invalid image index");
  return JSON.parse(readFileSync(path, "utf8"));
}

export function imageFilePath(dataDir: string, cvId: string, ref: ImageReference): string {
  const extension = ref.mimeType === "image/png" ? "png" : ref.mimeType === "image/jpeg" ? "jpg" : fail("unsupported image type");
  if (!shortId.test(ref.id) || ref.path !== `images/${ref.id}.${extension}`) fail("invalid image reference path");
  return join(directory(dataDir, cvId), `${ref.id}.${extension}`);
}

export function saveImage(dataDir: string, cvId: string, dataUrl: string): ImageReference {
  if (dataUrl.length > Math.ceil(MAX_BYTES / 3) * 4 + 30) fail("image exceeds 20 MiB limit");
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!match) fail("expected PNG or JPEG base64 data URL");
  const mimeType = match[1]!;
  const encoded = match[2]!;
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.toString("base64") !== encoded) fail("invalid base64 encoding");
  if (bytes.length > MAX_BYTES) fail("image exceeds 20 MiB limit");
  const size = dimensions(bytes, mimeType);
  const dir = directory(dataDir, cvId);
  mkdirSync(dir, { recursive: true });
  const index = readIndex(dir);
  const hash = digest(bytes);
  const existing = Object.values(index).find(image => image.hash === hash);
  if (existing) {
    readImageDataUrl(dataDir, cvId, existing.ref);
    return existing.ref;
  }
  const id = allocateRecordId(dataDir, cvId, "image");
  const ref = { id, path: `images/${id}.${mimeType === "image/png" ? "png" : "jpg"}`, mimeType, ...size, bytes: bytes.length };
  writeFileSync(imageFilePath(dataDir, cvId, ref), bytes, { flag: "wx" });
  index[id] = { hash, ref };
  const temporary = join(dir, `${id}.index.tmp`);
  writeFileSync(temporary, JSON.stringify(index), { flag: "wx" });
  renameSync(temporary, join(dir, "index.json"));
  appendAsset(dataDir, cvId, {
    name: `${id}.${mimeType === "image/png" ? "png" : "jpg"}`,
    kind: "image",
    bytes: ref.bytes,
    summary: imageSummary({ width: ref.width, height: ref.height, mime: mimeType, bytes: ref.bytes }),
    source: {},
    path: ref.path,
  });
  return ref;
}

export function readImageDataUrl(dataDir: string, cvId: string, ref: ImageReference): string {
  const path = imageFilePath(dataDir, cvId, ref);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_BYTES || stat.size !== ref.bytes) fail("image file size or type mismatch");
  const bytes = readFileSync(path);
  const hash = readIndex(directory(dataDir, cvId))[ref.id]?.hash;
  if (digest(bytes) !== hash) fail("image content hash mismatch");
  const size = dimensions(bytes, ref.mimeType);
  if (size.width !== ref.width || size.height !== ref.height) fail("image dimensions mismatch");
  return `data:${ref.mimeType};base64,${bytes.toString("base64")}`;
}
