import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveImage } from "../images/store.ts";
import { emptyLedger, saveLedger } from "../runtime/store.ts";
import { runImageTool } from "./image-crop.ts";
import type { BrowserHost } from "../types.ts";

// 1×1 PNG
const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("image.crop validates rect and requires a stored image", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-image-crop-"));
  try {
    const host: BrowserHost = {
      readOpenTabs: async () => ({ ok: true, windows: [] }),
      execute: async (name, input) => {
        if (name === "image.crop_pixels") return { ok: true, dataUrl: String(input.dataUrl) };
        return { ok: false, error: "unexpected" };
      },
    };
    await expect(runImageTool("image.crop", { imageId: "img_01", x: 0, y: 0, width: 1, height: 1 }, host, dataDir, "cv_01"))
      .resolves.toMatchObject({ ok: false });
    await expect(runImageTool("image.crop", { imageId: "img_01", x: 0, y: 0, width: 0, height: 1 }, host, dataDir, "cv_01"))
      .resolves.toMatchObject({ ok: false });

    const ledger = emptyLedger("cv_01");
    const ref = saveImage(dataDir, "cv_01", tinyPng);
    ledger.toolIO.push({
      callId: "call_01", turnId: "tn_01", name: "capture_page", arguments: {},
      return: { stage: "complete", totalChars: 1, text: "{}" },
      images: [ref],
    });
    saveLedger(dataDir, ledger);
    await expect(runImageTool("image.crop", { imageId: ref.id, x: 5, y: 0, width: 4, height: 1 }, host, dataDir, "cv_01"))
      .resolves.toMatchObject({ ok: false });
    const cropped = await runImageTool("image.crop", { imageId: ref.id, x: 0, y: 0, width: 1, height: 1 }, host, dataDir, "cv_01");
    expect(cropped).toMatchObject({ ok: true, width: 1, height: 1, sourceImageId: ref.id, admitted: "inline" });
    expect(String(cropped.imageId)).toMatch(/^img_[0-9]{2,}$/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
