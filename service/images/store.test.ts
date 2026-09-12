import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageFilePath, readImageDataUrl, saveImage } from "./store.ts";

// Real 2 × 1 red images, encoded once with sharp; no encoder is needed at runtime.
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWP4z8Dwn4EBAAj+Af/KOtJRAAAAAElFTkSuQmCC";
const jpeg = "data:image/jpeg;base64,/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z";

test("images persist as deduplicated binary files and round trip exactly", () => {
  const root = mkdtempSync(join(tmpdir(), "tchrome-images-"));
  try {
    for (const data of [png, jpeg]) {
      const ref = saveImage(root, "cv_1", data);
      expect([ref.width, ref.height]).toEqual([2, 1]);
      expect(saveImage(root, "cv_1", data)).toEqual(ref);
      expect(readImageDataUrl(root, "cv_1", ref)).toBe(data);
      expect(ref.path).toMatch(/^images\/img_[0-9]{2,}\.(png|jpg)$/);
      expect(JSON.stringify(ref)).not.toContain("base64");
      expect(() => readImageDataUrl(root, "cv_2", ref)).toThrow();
    }
    expect(readdirSync(join(root, "conversations/cv_1/images")).filter(name => /\.(png|jpg)$/.test(name))).toHaveLength(2);
    expect(saveImage(root, "cv_1", png).id).toBe("img_01");
    expect(saveImage(root, "cv_1", jpeg).id).toBe("img_02");
    expect(saveImage(root, "cv_2", jpeg).id).toBe("img_01");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid, mislabeled, truncated and oversized image payloads are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "tchrome-images-"));
  try {
    for (const invalid of ["", "data:image/png;base64,@@", "data:image/png;base64,YQ=", png.replace("png", "jpeg"), jpeg.replace("jpeg", "png"), png.slice(0, -4), jpeg.slice(0, -4)]) {
      expect(() => saveImage(root, "cv_1", invalid)).toThrow("image:");
    }
    expect(() => saveImage(root, "cv_1", `data:image/png;base64,${Buffer.alloc(20 * 1024 * 1024 + 1).toString("base64")}`)).toThrow("20 MiB");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("references cannot escape the conversation or conceal changed image content", () => {
  const root = mkdtempSync(join(tmpdir(), "tchrome-images-"));
  try {
    const ref = saveImage(root, "cv_1", png);
    for (const changed of [{ path: "../outside.png" }, { id: "../../outside" }, { bytes: ref.bytes + 1 }, { width: 42 }, { mimeType: "image/jpeg" }]) {
      expect(() => readImageDataUrl(root, "cv_1", { ...ref, ...changed })).toThrow("image:");
    }
    expect(() => saveImage(root, "../escape", png)).toThrow("conversation id");
    const path = imageFilePath(root, "cv_1", ref);
    const corrupted = Buffer.from(png.split(",")[1]!, "base64");
    corrupted[corrupted.length - 1] = 0;
    writeFileSync(path, corrupted);
    expect(() => readImageDataUrl(root, "cv_1", ref)).toThrow("hash mismatch");
    rmSync(path);
    const outside = join(root, "outside.png");
    writeFileSync(outside, Buffer.from(png.split(",")[1]!, "base64"));
    symlinkSync(outside, path);
    expect(() => readImageDataUrl(root, "cv_1", ref)).toThrow("type mismatch");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
