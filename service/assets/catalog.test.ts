import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAsset, imageSummary, loadAssets, textSummary } from "./catalog.ts";

test("text summary takes title and first sentence; image summary stays factual", () => {
  expect(textSummary("# 标题\n\n第一句完整。第二句。")).toBe("标题 · 第一句完整。");
  expect(textSummary("只有一句")).toContain("只有一句");
  expect(imageSummary({ width: 800, height: 600, bytes: 1234, tool: "capture_page", tabTitle: "列表" }))
    .toBe("800×600 · capture_page · 列表 · 1234B");
});

test("appendAsset allocates ast ids and persists the catalog", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-assets-"));
  try {
    const first = appendAsset(dataDir, "cv_01", {
      name: "call_01.txt", kind: "text", bytes: 10, summary: "摘要", source: { callId: "call_01" }, path: "returns/call_01.txt",
    });
    const second = appendAsset(dataDir, "cv_01", {
      name: "img_01.png", kind: "image", bytes: 20, summary: "8×8", source: {}, path: "images/img_01.png",
    });
    expect(first.assetId).toMatch(/^ast_[0-9]{2,}$/);
    expect(second.assetId).toMatch(/^ast_[0-9]{2,}$/);
    expect(second.assetId).not.toBe(first.assetId);
    expect(loadAssets(dataDir, "cv_01")).toHaveLength(2);
    expect(loadAssets(dataDir, "cv_01")[0]).toMatchObject({ kind: "text", summary: "摘要" });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("loadAssets filters by kind and name for asset.list", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-assets-filter-"));
  try {
    appendAsset(dataDir, "cv_01", { name: "call_01.txt", kind: "text", bytes: 1, summary: "a", source: {}, path: "returns/call_01.txt" });
    appendAsset(dataDir, "cv_01", { name: "img_01.png", kind: "image", bytes: 2, summary: "b", source: {}, path: "images/img_01.png" });
    const all = loadAssets(dataDir, "cv_01");
    expect(all.filter((item) => item.kind === "image")).toHaveLength(1);
    expect(all.filter((item) => item.name.includes("call_"))).toHaveLength(1);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
