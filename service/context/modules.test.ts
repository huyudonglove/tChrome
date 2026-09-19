import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadContextModules, parseModule, renderSlots, systemTextFromModules } from "./modules.ts";
import { systemText, userText } from "./window.ts";
import { emptyLedger } from "../runtime/store.ts";
import type { Turn } from "../types.ts";

const root = resolve(import.meta.dir, "../..");
const xmlTags = (text: string) => Array.from(text.matchAll(/^<([A-Za-z][A-Za-z0-9]*)>$/gm), m => m[1]);

test("registry loads XML modules and system text uses angle-bracket tags", () => {
  const modules = loadContextModules(root);
  expect(modules.systemOrder[0]).toBe("#overview");
  expect(modules.systemOrder).toContain("#identity");
  expect(modules.userOrder).toContain("#toolIO");
  const system = systemTextFromModules(modules, "2026-09-06", "GUIDE", { cwd: "/tmp/tchrome-test", dataDir: "/tmp/tchrome-data", os: "macOS (darwin/arm64)" });
  expect(system.startsWith("<overview>")).toBe(true);
  expect(system).toContain("</overview>");
  expect(system).toContain("2026-09-06");
  expect(system).toContain("服务数据目录（绝对路径，脚本/进程输出/会话落盘都在此）：/tmp/tchrome-data");
  expect(system).toContain("代码仓库路径（仅服务源码位置）：/tmp/tchrome-test");
  expect(system).toContain("操作系统：macOS (darwin/arm64)");
  expect(system).toContain("<identity>");
  expect(system).toContain("</identity>");
  expect(system).toContain("<runtime>");
  expect(system).toContain("GUIDE");
  expect(system).not.toContain("#identity");
});

test("user window renders B-style XML modules with data under 内容", () => {
  const modules = loadContextModules(root);
  const ledger = emptyLedger("cv_xml");
  ledger.notes = { candidate: "草稿 {{literal}}" };
  const turn: Turn = {
    goalChanges: [], turnId: "tn_01", conversationId: "cv_xml", status: "inferring",
    createdAt: "", completedAt: null,
    input: { id: "input_01", text: "用户输入", submittedAt: "" },
    output: null,
    assembled: { baseToolsIds: [], toolIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], openTabs: { ok: true, windows: [] }, currentPage: null, pageObservedHistory: [] },
  };
  const output = userText({ contextModules: modules, ledger, turn, memories: { project: "[]", conversation: "[]" }, skillText: "技能正文" });
  expect(output).toContain("<skill>");
  expect(output).toContain("能力：");
  expect(output).toContain("内容：\n技能正文");
  expect(output).toContain("用户输入");
  expect(xmlTags(output)).toEqual(modules.userOrder.map(tag => tag.slice(1)));
});

test("parseModule accepts B XML and rejects malformed shells", () => {
  const ok = parseModule("<demo>\n能力：【Test】\n\n详细描述：\n正文\n</demo>", "demo");
  expect(ok.tag).toBe("#demo");
  expect(() => parseModule("#demo\n能力：【Test】\n\n详细描述：\n正文", "demo")).toThrow();
});
