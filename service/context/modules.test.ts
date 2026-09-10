import { afterEach, expect, test } from "bun:test";
import { readFileSync, readdirSync, mkdtempSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContextModules, parseModule, renderSlots, slotNames } from "./modules.ts";
import { loadToolRegistry, toolSchemas, toolUsageFor } from "../tools/registry.ts";
import { systemText, userText } from "./window.ts";
import { emptyLedger } from "../runtime/store.ts";
import type { Turn } from "../types.ts";

const root = join(import.meta.dir, "../..");
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const copyContext = () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-modules-"));
  directories.push(dir);
  cpSync(join(root, "service/context"), join(dir, "service/context"), { recursive: true });
  return dir;
};
const headings = (text: string): string[] => Array.from(text.match(/^#[A-Za-z][A-Za-z0-9]*$/gm) ?? []);
const navigationTags = (text: string) => Array.from(text.matchAll(/^(#[A-Za-z][A-Za-z0-9]*) --【[^\n]+】$/gm), match => match[1]);
const fixtureTurn = (): Turn => ({
  turnId: "tn_slots", conversationId: "cv_slots", status: "inferring", createdAt: "", completedAt: null,
  input: { text: "用户输入 {{#goal}} {{data}}", submittedAt: "" }, output: null,
  assembled: { baseToolsIds: [], toolIds: [],  conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], currentTab: null, currentPage: null, pageObservedHistory: [] },
});

test("reordering only inventories changes both navigations and corresponding bodies", () => {
  const dir = copyContext();
  const original = loadContextModules(dir);
  writeFileSync(join(dir, "service/context/README.md"), "HUMAN_ONLY_SENTINEL");
  for (const role of ["system", "user"] as const) {
    const order = role === "system" ? original.systemOrder : original.userOrder;
    writeFileSync(join(dir, `service/context/${role}-slots.md`), [...order].reverse().map((tag, index) => `${index + 1}. ${tag.slice(1)}`).join("\n"));
  }
  const reordered = loadContextModules(dir);
  expect(reordered.systemOrder).toEqual([...original.systemOrder].reverse());
  expect(reordered.userOrder).toEqual([...original.userOrder].reverse());
  const system = systemText(reordered, "");
  expect(system).toBe(`${reordered.systemInventory}\n\n${reordered.userInventory}`);
  expect(navigationTags(system)).toEqual([...reordered.systemOrder, ...reordered.userOrder]);
  expect(headings(system)).toEqual([]);
  expect(headings(renderSlots(reordered.userOrder, reordered.userSlots, {}))).toEqual(reordered.userOrder);
  expect(system).not.toContain("HUMAN_ONLY_SENTINEL");
});

test("user data is interpolated once and remains separate from navigation and module capabilities", () => {
  const modules = loadContextModules(root);
  const ledger = emptyLedger("cv_slots");
  ledger.goal = "当前目标";
  ledger.notes = { candidate: "来自用户的 {{unknown}}" };
  const turn = fixtureTurn();
  const output = userText({ contextModules: modules, ledger, turn, memories: { project: "", conversation: "" }, toolUsage: "工具说明 {{data}}", skillText: "独立技能正文 {{data}} {{unknown}}" });
  expect(headings(output)).toEqual(modules.userOrder);
  expect(output).toContain(turn.input.text);
  expect(output).toContain(ledger.notes.candidate!);
  expect(output).toContain("工具说明 {{data}}");
  expect(output).not.toContain(modules.systemInventory);
  expect(output).not.toContain(modules.userInventory);
  expect(output).not.toMatch(/^能力：|^详细描述：/m);
  expect(output).toContain("#skill\n\n独立技能正文 {{data}} {{unknown}}");
});

test.each([
  ["missing file", (dir: string) => rmSync(join(dir, "service/context/system/identity.md"))],
  ["unlisted file", (dir: string) => writeFileSync(join(dir, "service/context/system/orphan.md"), "#orphan\n能力：【未列模块】\n\n详细描述：\n正文")],
  ["duplicate tag", (dir: string) => {
    const path = join(dir, "service/context/system/identity.md");
    writeFileSync(path, readFileSync(path, "utf8").replace(/^#identity/, "#environment"));
  }],
  ["missing capability", (dir: string) => {
    const path = join(dir, "service/context/system/identity.md");
    writeFileSync(path, readFileSync(path, "utf8").replace(/^能力：.*\n/m, ""));
  }],
  ["malformed capability", (dir: string) => {
    const path = join(dir, "service/context/system/identity.md");
    writeFileSync(path, readFileSync(path, "utf8").replace(/^能力：.*$/m, "能力：没有括号"));
  }],
  ["missing body marker", (dir: string) => {
    const path = join(dir, "service/context/system/identity.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("详细描述：", ""));
  }],
  ["unknown placeholder", (dir: string) => {
    const path = join(dir, "service/context/user/goal.md");
    writeFileSync(path, readFileSync(path, "utf8") + "\n{{unknown_placeholder}}");
  }],
] as const)("loader rejects %s instead of silently producing a partial window", (_name, mutate) => {
  const dir = copyContext();
  mutate(dir);
  expect(() => loadContextModules(dir)).toThrow();
});

test("inventory accepts only contiguous numbered basenames and rejects duplicate entries", () => {
  expect(slotNames("# List\n\n1. identity\r\n2. pageObservedHistory\n")).toEqual(["#identity", "#pageObservedHistory"]);
  for (const inventory of ["# Empty", "1. identity\n2. identity", "2. identity", "1. #identity", "1. ../identity", "1. identity --【重复能力】", "| 1 | `#identity` | description |"])
    expect(() => slotNames(inventory)).toThrow();
});

test("missing render targets and unknown body placeholders are rejected while literal data survives", () => {
  const modules = loadContextModules(root);
  const goal = modules.userSlots["#goal"]!;
  expect(() => renderSlots(["#missing"], modules.userSlots, {})).toThrow();
  expect(() => renderSlots(["#goal"], { "#goal": { ...goal, body: "{{unknown}}" } }, {})).toThrow();
  expect(renderSlots(["#goal"], { "#goal": { ...goal, body: "{{data}}" } }, { "#goal": "{{data}} {{unknown}} {{#goal}}" }))
    .toBe("#goal\n\n{{data}} {{unknown}} {{#goal}}");
});

test("generated examples use the current navigation, body order and tool schemas", () => {
  const modules = loadContextModules(root);
  const registry = loadToolRegistry(root);
  for (const file of readdirSync(join(root, "docs/examples")).filter(name => name.endsWith(".md"))) {
    const text = readFileSync(join(root, "docs/examples", file), "utf8");
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const record = value as Record<string, any>;
      if (record.systemSlots) expect(record.systemSlots).toEqual(modules.systemOrder);
      if (record.userSlots) expect(record.userSlots).toEqual(modules.userOrder);
      if (record.type === "function" && record.function?.name && record.function.parameters)
        expect(record.function).toEqual(toolSchemas(registry, [record.function.name])[0]!.function);
      Object.values(record).forEach(visit);
    };
    for (const fence of text.matchAll(/^```json\n([\s\S]*?)^```/gm)) visit(JSON.parse(fence[1]!));
    if (file.startsWith("03-") || file.startsWith("04-")) {
      expect(text).toContain(`\`\`\`\n${systemText(modules, toolUsageFor(registry, registry.toolGroups.baseToolsIds))}\n\`\`\``);
      const renderedUser = text.match(/^```\n(#skill\n[\s\S]*?)^```/m)?.[1];
      expect(headings(renderedUser ?? "")).toEqual(modules.userOrder);
      expect(renderedUser).not.toMatch(/^能力：|^详细描述：/m);
    }
  }
});

test("module parser rejects blank capabilities, blank bodies and duplicate placeholders", () => {
  const valid = "#sample\n能力：【用途】\n\n详细描述：\n{{data}}";
  expect(parseModule(valid, "#sample")).toEqual({ tag: "#sample", capability: "【用途】", body: "{{data}}" });
  for (const source of [
    valid.replace("【用途】", "【  】"), valid.replace("{{data}}", "  "),
    valid.replace("{{data}}", "{{data}}\n{{data}}"), valid.replace("{{data}}", "{{other}}"),
  ]) expect(() => parseModule(source, "#sample")).toThrow();
});

test("the same tag cannot be listed in system and user", () => {
  const dir = copyContext();
  const path = join(dir, "service/context/user-slots.md");
  const order = slotNames(readFileSync(path, "utf8"));
  writeFileSync(path, ["#identity", ...order.slice(1)].map((tag, index) => `${index + 1}. ${tag.slice(1)}`).join("\n"));
  expect(() => loadContextModules(dir)).toThrow("duplicate tag");
});

test("user input history is an array preserving message boundaries and multiline content", () => {
  const modules = loadContextModules(root);
  const ledger = emptyLedger("cv_slots");
  const turn = fixtureTurn();
  const render = () => userText({ contextModules: modules, ledger, turn,
    memories: { project: "", conversation: "" }, toolUsage: "", skillText: "测试技能" });
  const history = () => {
    const section = render().split("\n#userInputHistory\n")[1]!.split("\n#goal\n")[0]!;
    return JSON.parse(section.trim());
  };
  expect(history()).toEqual([]);
  ledger.userInputHistory = ["第一句\n补充一行", '包含"引号"和{{data}}', "第三句"];
  expect(history()).toEqual(ledger.userInputHistory);
  expect(history()).not.toContain(turn.input.text);
});

test("user descriptions appear only in system navigation while user bodies contain data", () => {
  const modules = loadContextModules(root);
  const system = systemText(modules, "");
  const data = Object.fromEntries(modules.userOrder.map(tag => [tag, `VALUE_${tag}`]));
  const user = renderSlots(modules.userOrder, modules.userSlots, data);
  for (const tag of modules.userOrder) {
    const module = modules.userSlots[tag]!;
    expect(module.description?.trim()).toBeTruthy();
    expect(modules.userInventory).toContain(`${tag} --${module.capability}\n${module.description}`);
    expect(system.split(module.description!)).toHaveLength(2);
    expect(user).not.toContain(module.description!);
  }
  expect(user).not.toMatch(/^能力：|^详细描述：|^内容：/m);
});

test("skill navigation describes injected skills without storing their operational methods", () => {
  // The copied fixture deliberately contains context only: context must not load skills itself.
  const modules = loadContextModules(copyContext());
  const skill = modules.userSlots["#skill"]!;
  const methods = "SKILL_METHODS_FROM_RUNTIME {{data}} {{unknown}}";
  const system = systemText(modules, "");
  const user = renderSlots(modules.userOrder, modules.userSlots, { "#skill": methods });
  expect(skill.description).toBeTruthy();
  expect(skill.body).toBe("{{data}}");
  expect(system).toContain(skill.description!);
  expect(system).not.toContain(methods);
  expect(user).toContain(`#skill\n\n${methods}`);
  expect(user).not.toContain(skill.description!);
  expect(renderSlots(["#skill"], modules.userSlots, {})).not.toContain(methods);
});

test("user modules require separate nonblank descriptions and content", () => {
  const valid = "#sample\n能力：【用途】\n\n详细描述：\n说明仅作字段指导\n\n内容：\n{{data}}";
  expect(parseModule(valid, "#sample")).toEqual({ tag: "#sample", capability: "【用途】", description: "说明仅作字段指导", body: "{{data}}" });
  const dir = copyContext();
  const path = join(dir, "service/context/user/goal.md");
  writeFileSync(path, "#goal\n能力：【目标】\n\n详细描述：\n{{data}}");
  expect(() => loadContextModules(dir)).toThrow();
  writeFileSync(path, "#goal\n能力：【目标】\n\n详细描述：\n   \n\n内容：\n{{data}}");
  expect(() => loadContextModules(dir)).toThrow();
});

test("user descriptions cannot interpolate runtime data and system modules cannot have a content section", () => {
  const dir = copyContext();
  const userPath = join(dir, "service/context/user/goal.md");
  const originalUser = readFileSync(userPath, "utf8");
  writeFileSync(userPath, originalUser.replace("详细描述：\n", "详细描述：\n{{data}}\n"));
  expect(() => loadContextModules(dir)).toThrow();
  writeFileSync(userPath, originalUser);
  const systemPath = join(dir, "service/context/system/identity.md");
  writeFileSync(systemPath, readFileSync(systemPath, "utf8") + "\n\n内容：\n不允许的第二部分");
  expect(() => loadContextModules(dir)).toThrow();
});

test("system modules combine capability and rules once, including literal dynamic tool usage", () => {
  const modules = loadContextModules(root);
  const usage = "TOOL_DESCRIPTION {{data}} {{literal}}";
  const system = systemText(modules, usage);
  for (const tag of modules.systemOrder) {
    const module = modules.systemSlots[tag]!;
    const text = module.body.replace("{{data}}", () => usage).trimEnd();
    expect(system.split(`${tag} --${module.capability}\n${text}`)).toHaveLength(2);
  }
  expect(system.split(usage)).toHaveLength(2);
  expect(headings(system)).toEqual([]);
  expect(system.endsWith(modules.userInventory)).toBe(true);
});
