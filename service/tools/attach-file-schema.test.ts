import { expect, test } from "bun:test";
import { loadToolRegistry, toolSchemas } from "./registry.ts";
import { checkToolCalls } from "./schema.ts";

const root = "/Users/huyudong/Projects/tChrome";
const registry = loadToolRegistry(root);

test("attach_file accepts path or paths with optional selector and page id", () => {
  const tools = toolSchemas(registry, ["attach_file"]);
  const a = checkToolCalls([{
    id: "c1",
    name: "attach_file",
    arguments: { reason: "上传模型", affectsPage: true, tabId: 12, path: "/tmp/model.glb" },
  }], tools, [], ["attach_file"]);
  expect(a.schemaOk).toBe(true);
  const b = checkToolCalls([{
    id: "c2",
    name: "attach_file",
    arguments: {
      reason: "多文件",
      affectsPage: true,
      tabId: 12,
      paths: ["/tmp/a.png", "/tmp/b.png"],
      selector: "input[type=file]",
    },
  }], tools, [], ["attach_file"]);
  expect(b.schemaOk).toBe(true);
  const c = checkToolCalls([{
    id: "c3",
    name: "attach_file",
    arguments: { reason: "按页内 id", affectsPage: true, tabId: 12, paths: ["/tmp/c.obj"], id: "e_09" },
  }], tools, [], ["attach_file"]);
  expect(c.schemaOk).toBe(true);
});

test("attach_file still requires reason and tabId", () => {
  const tools = toolSchemas(registry, ["attach_file"]);
  const missing = checkToolCalls([{
    id: "c1",
    name: "attach_file",
    arguments: { tabId: 1, path: "/tmp/x" },
  }], tools, [], ["attach_file"]);
  expect(missing.schemaOk).toBe(false);
});
