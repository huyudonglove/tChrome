import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWidgetPage, saveWidgetHtml } from "./store";

test("widget store saves full HTML page and reads it back", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-widget-"));
  try {
    const saved = saveWidgetHtml(dataDir, `<button onclick="x()">抽取灵感</button>`);
    expect("id" in saved && saved.id.startsWith("w_")).toBe(true);
    if (!("id" in saved)) return;
    const page = readWidgetPage(dataDir, saved.id);
    expect(page).toContain("抽取灵感");
    expect(page).toContain("<!doctype html>");
    expect(readWidgetPage(dataDir, "bad-id")).toBeNull();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
