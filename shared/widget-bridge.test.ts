import { expect, test } from "bun:test";
import { resolveWidgetHeight, WIDGET_FIT_SCRIPT, WIDGET_HEIGHT_MESSAGE, WIDGET_MAX_HEIGHT, WIDGET_MIN_HEIGHT } from "./widget-bridge";

test("fit script reports the document height with the shared protocol message", () => {
  expect(WIDGET_FIT_SCRIPT.startsWith("<script>")).toBe(true);
  expect(WIDGET_FIT_SCRIPT.endsWith("</script>")).toBe(true);
  expect(WIDGET_FIT_SCRIPT).toContain(WIDGET_HEIGHT_MESSAGE);
  expect(WIDGET_FIT_SCRIPT).toContain("scrollHeight");
  expect(WIDGET_FIT_SCRIPT).toContain("parent.postMessage");
});

test("resolveWidgetHeight accepts only this protocol and clamps the value", () => {
  expect(resolveWidgetHeight({ type: WIDGET_HEIGHT_MESSAGE, height: 512.4 })).toBe(512);
  expect(resolveWidgetHeight({ type: WIDGET_HEIGHT_MESSAGE, height: 4 })).toBe(WIDGET_MIN_HEIGHT);
  expect(resolveWidgetHeight({ type: WIDGET_HEIGHT_MESSAGE, height: 99999 })).toBe(WIDGET_MAX_HEIGHT);
  expect(resolveWidgetHeight({ type: "other", height: 500 })).toBeNull();
  expect(resolveWidgetHeight({ type: WIDGET_HEIGHT_MESSAGE, height: "tall" })).toBeNull();
  expect(resolveWidgetHeight({ type: WIDGET_HEIGHT_MESSAGE, height: -3 })).toBeNull();
  expect(resolveWidgetHeight({ height: 500 })).toBeNull();
  expect(resolveWidgetHeight(null)).toBeNull();
  expect(resolveWidgetHeight("tchrome-widget-height")).toBeNull();
});
