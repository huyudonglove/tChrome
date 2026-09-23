import { expect, test } from "bun:test";
import { loadToolRegistry, toolSchemas } from "./registry.ts";
import { checkToolCalls } from "./schema.ts";

const root = "/Users/huyudong/Projects/tChrome";
const registry = loadToolRegistry(root);

test("har video and fingerprint tools are registered", () => {
  for (const name of ["har", "video.capture_sequence", "video.record", "fingerprint.read", "fingerprint.apply"]) {
    expect(registry.tools[name], name).toBeTruthy();
    expect(registry.toolGroups.coreToolIds, name).toContain(name);
  }
  const tools = toolSchemas(registry, ["har", "video.capture_sequence", "video.record", "fingerprint.read", "fingerprint.apply"]);
  expect(checkToolCalls([
    { id: "c1", name: "har", arguments: { reason: "录网络", tabId: 12, action: "start" } },
    { id: "c2", name: "har", arguments: { reason: "导出", tabId: 12, action: "stop" } },
    { id: "c3", name: "video.capture_sequence", arguments: { reason: "序列截图", tabId: 12, count: 3, intervalMs: 400 } },
    { id: "c4", name: "video.record", arguments: { reason: "开始录制", tabId: 12, action: "start", fps: 2, maxFrames: 10 } },
    { id: "c5", name: "video.record", arguments: { reason: "停止录制", tabId: 12, action: "stop" } },
    { id: "c6", name: "fingerprint.read", arguments: { reason: "读指纹", tabId: 12 } },
    { id: "c7", name: "fingerprint.apply", arguments: { reason: "模拟 UA", tabId: 12, userAgent: "Mozilla/5.0", timezone: "Asia/Shanghai", width: 390, height: 844, mobile: true } },
  ], tools, registry.toolGroups.coreToolIds, ["har", "video.capture_sequence", "video.record", "fingerprint.read", "fingerprint.apply"]).schemaOk).toBe(true);
});
