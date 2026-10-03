import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadContextModules, parseModule, renderSlots, systemTextFromModules } from "./modules.ts";
import { systemText, userText, windowChars } from "./window.ts";
import { emptyLedger } from "../runtime/store.ts";
import { promptNumberSlots, assertPromptNumbersMatchRuntime } from "./prompt-numbers.ts";
import { SUMMARY_RECOMPRESS_MIN_ACTIVE } from "../agents/compression/index.ts";
import { runtimeConfig } from "../config/runtime.ts";
import type { Turn } from "../types.ts";

const root = resolve(import.meta.dir, "../..");
const xmlTags = (text: string) => Array.from(text.matchAll(/^<([A-Za-z][A-Za-z0-9]*)(?:\s[^>]*)?>$/gm), m => m[1]);

test("registry loads XML modules and system text uses angle-bracket tags", () => {
  const modules = loadContextModules(root);
  expect(modules.systemOrder[0]).toBe("#overview");
  expect(modules.systemOrder).toContain("#identity");
  expect(modules.userOrder).toContain("#conversation");
  const system = systemTextFromModules(modules, "2026-09-06", "GUIDE", { cwd: "/tmp/tchrome-test", dataDir: "/tmp/tchrome-data", os: "macOS (darwin/arm64)" }, "- web-observation：观察页面。");
  expect(system.startsWith("<overview>")).toBe(true);
  expect(system).toContain("</overview>");
  expect(system).toContain("2026-09-06");
  expect(system).toContain("服务数据目录（脚本 scripts/、进程输出 process-output/、会话落盘、临时文件）：/tmp/tchrome-data");
  expect(system).toContain("代码仓库路径（服务源码）：/tmp/tchrome-test");
  expect(system).toContain("操作系统：macOS (darwin/arm64)");
  expect(SUMMARY_RECOMPRESS_MIN_ACTIVE).toBe(runtimeConfig.context.summaryRecompressMinActive);
  const slots = promptNumberSlots();
  const { intentMaxChars: _, ...systemSlots } = slots;
  for (const value of Object.values(systemSlots)) expect(system).toContain(value);
  expect(() => assertPromptNumbersMatchRuntime(system)).not.toThrow();
  expect(system).toContain("<systemSkill>");
  expect(system).toContain("skill_load");
  expect(system).toContain("- web-observation：观察页面。");
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
    turnId: "tn_01", conversationId: "cv_xml", status: "inferring",
    createdAt: "", completedAt: null,
    input: { id: "input_01", text: "用户输入", submittedAt: "" },
    stopReason: null,
    assembled: { baseToolsIds: [], toolIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], currentTabs: { ok: true, windows: [] }, currentPage: null, observations: [] },
  };
  const output = userText({ contextModules: modules, ledger, turn, memories: { project: "[]", conversation: "[]" }, skillText: "技能正文" });
  expect(output).toContain("<skill>");
  expect(output).toContain("能力：");
  expect(output).toContain("内容：\n技能正文");
  expect(output).toContain("用户输入");
  expect(output).toContain('<conversation id="cv_xml">');
  expect(output).toContain("<tn_01>");
  expect(output).toContain("</tn_01>");
  const topTags = Array.from(output.matchAll(/^<([A-Za-z][A-Za-z0-9]*)(?: [a-z]+="[^"]*")*>\n能力：/gm), m => m[1]);
  expect(topTags).toEqual(modules.userOrder.map(tag => tag.slice(1)));
});

test("<conversation> reports its conversation id and window occupancy", () => {
  const modules = loadContextModules(root);
  const ledger = emptyLedger("cv_budget");
  const turn: Turn = {
    turnId: "tn_01", conversationId: "cv_budget", status: "inferring",
    createdAt: "", completedAt: null,
    input: { id: "input_01", text: "用户输入", submittedAt: "" },
    stopReason: null,
    assembled: { baseToolsIds: [], toolIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], currentTabs: { ok: true, windows: [] }, currentPage: null, observations: [] },
  };
  const system = "系统窗口文本";
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-window-"));
  try {
    const output = userText({ contextModules: modules, ledger, turn, memories: { project: "[]", conversation: "[]" }, skillText: "技能正文", inlineBudget: { dataDir, system } });
    const head = output.match(/^<conversation ([^>]*)>/m)?.[1] ?? "";
    expect(head).toContain('id="cv_budget"');
    const chars = Number(head.match(/chars="(\d+)"/)?.[1]);
    const limit = Number(head.match(/limit="(\d+)"/)?.[1]);
    expect(limit).toBe(runtimeConfig.context.compressAtChars);
    expect(head).toContain(`used="${Math.round((chars / limit) * 100)}%"`);
    // The read-out must describe the very window it is rendered into, attributes included.
    expect(chars).toBe(windowChars(system, output));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("parseModule accepts B XML and rejects malformed shells", () => {
  const ok = parseModule("<demo>\n能力：【Test】\n\n详细描述：\n正文\n</demo>", "demo");
  expect(ok.tag).toBe("#demo");
  expect(() => parseModule("#demo\n能力：【Test】\n\n详细描述：\n正文", "demo")).toThrow();
});
