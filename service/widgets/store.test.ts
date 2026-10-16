import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWidgetPage, saveWidgetHtml } from "./store";
import { WIDGET_FIT_SCRIPT, WIDGET_HEIGHT_MESSAGE } from "../../shared/widget-bridge.ts";

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

test("reading a widget page injects the height-report script exactly once", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-widget-fit-"));
  try {
    const saved = saveWidgetHtml(dataDir, `<div style="height:900px">高内容</div>`);
    expect("id" in saved).toBe(true);
    if (!("id" in saved)) return;
    const page = readWidgetPage(dataDir, saved.id);
    expect(page).toContain("高内容");
    expect(page).toContain(WIDGET_HEIGHT_MESSAGE);
    expect(page!.split(WIDGET_HEIGHT_MESSAGE).length - 1).toBe(1);
    expect(page!.indexOf(WIDGET_FIT_SCRIPT)).toBeGreaterThan(-1);
    expect(page!.indexOf(WIDGET_FIT_SCRIPT)).toBeLessThan(page!.lastIndexOf("</body>"));
    // 重复读取不会叠加脚本（旧组件页每次读取都走同一条注入路径）。
    expect(readWidgetPage(dataDir, saved.id)).toBe(page);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
