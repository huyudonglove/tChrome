import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadContextModules, loadModuleRegistry } from "./context/modules.ts";
import { coreToolIds, dynamicToolIds, loadToolRegistry, toolGuideFor } from "./tools/registry.ts";
import { promptNumberSlots } from "./context/prompt-numbers.ts";

const root = join(import.meta.dir, "..");

/** 已删除的概念：出现在提示词/描述里即视为残留复活。用词边界匹配，避免误伤 local_fs_write 这类合法包含。 */
const DEAD_PATTERNS: RegExp[] = [
  /(?<![A-Za-z_])reportProgress(?![A-Za-z_])/,
  /(?<![A-Za-z_])currentQuery(?![A-Za-z_])/,
  /checkContinuePrompt/,
  /checkContinueHard/,
  /\{tag, actions, result\}/,
  /"tag":/,
  /(?<![A-Za-z_])fs_write(?![A-Za-z_])/,
  /`fs_read`/,
  /`fs_list`/,
];

const docFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (entry.name.endsWith(".md") || entry.name.endsWith(".json")) out.push(path);
    }
  };
  for (const dir of ["service/context", "service/skills", "service/agents", "service/tools/definitions"]) {
    walk(join(root, dir));
  }
  return out;
};

/** 写在 .ts 里的系统提示词载体；新增这类常量时登记到此，下面的用例会核对是否有遗漏。 */
const promptTsFiles = ["service/agents/subagent/executor.ts"];

/** 可能承载提示词的全部文件：既有 md/json，也有登记在案的 .ts 载体。 */
const promptSources = (): string[] => [...docFiles(), ...promptTsFiles.map((rel) => join(root, rel))];

test("prompts and tool descriptions contain no resurrected dead concepts", () => {
  const bad: string[] = [];
  for (const file of docFiles()) {
    const text = readFileSync(file, "utf8");
    for (const pattern of DEAD_PATTERNS) {
      if (pattern.test(text)) bad.push(`${file}: ${pattern}`);
    }
  }
  expect(bad).toEqual([]);
});

test("tool names referenced in prompts exist in the registry", () => {
  const registry = loadToolRegistry(root);
  const known = new Set(Object.keys(registry.tools));
  // 常见误写：掉了 local_/page_ 前缀。反向匹配能精准抓到这类，其它英文词不误伤。
  const prefixes = ["local_", "page_"];
  const bad: string[] = [];
  for (const file of docFiles()) {
    if (file.endsWith(".json")) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/`([a-z][a-z0-9_]{4,}?)`/g)) {
      const name = match[1]!;
      if (known.has(name)) continue;
      const fixed = prefixes.map((prefix) => `${prefix}${name}`).find((candidate) => known.has(candidate));
      if (fixed) bad.push(`${file}: \`${name}\` 应为 \`${fixed}\``);
    }
  }
  expect(bad).toEqual([]);
});

test("module placeholders come from a declared inject key or a runtime slot", () => {
  const runtimeSlots = new Set(["currentDate", "dataDir", "cwd", "os", "data"]);
  const bad: string[] = [];
  for (const row of loadModuleRegistry(root).modules) {
    if (!row.file) continue;
    const declared = new Set(row.inject ?? []);
    const text = readFileSync(join(root, "service/context", row.file), "utf8");
    for (const match of text.matchAll(/\{\{(\w+)\}\}/g)) {
      const key = match[1]!;
      if (!declared.has(key) && !runtimeSlots.has(key)) bad.push(`${row.file}: {{${key}}} 没有对应来源`);
    }
  }
  expect(bad).toEqual([]);
});

test("declared inject keys are actually used in the module body", () => {
  const bad: string[] = [];
  for (const row of loadModuleRegistry(root).modules) {
    if (!row.file || !row.inject?.length) continue;
    const text = readFileSync(join(root, "service/context", row.file), "utf8");
    for (const key of row.inject) {
      if (!text.includes(`{{${key}}}`)) bad.push(`${row.file}: 声明了 {{${key}}} 却在正文中没有使用`);
    }
  }
  expect(bad).toEqual([]);
});

test("<tools> wording names the same sources the assembler renders", () => {
  const registry = loadToolRegistry(root);
  const loopSource = readFileSync(join(root, "service/runtime/loop.ts"), "utf8");
  // 实际渲染集合由 loop.ts 的 assemble 决定：核心工具 ∪ 本会话加载的动态工具。
  expect(loopSource).toMatch(/toolIds:\s*\[\.\.\.new Set\(\[\.\.\.coreToolIds\([^)]*\),\s*\.\.\.loadedToolIds\]\)\]/);
  const tools = loadContextModules(root).userSlots["#tools"]!;
  const wording = `${tools.purpose}\n${tools.template}`;
  expect(wording).toContain("核心工具");
  expect(wording).toContain("动态工具");
  const sample = dynamicToolIds(registry)[0]!;
  const rendered = [...new Set([...coreToolIds(registry), sample])];
  expect(() => toolGuideFor(registry, rendered, false)).not.toThrow();
});

test("every prompt number slot is referenced by a template", () => {
  const slots = promptNumberSlots();
  const used = new Set<string>();
  for (const file of promptSources()) {
    for (const match of readFileSync(file, "utf8").matchAll(/\{\{(\w+)\}\}/g)) used.add(match[1]!);
  }
  const dead = Object.keys(slots).filter((key) => !used.has(key));
  expect(dead).toEqual([]);
});

test(".ts prompt carriers are all registered for the prompt scan", () => {
  const declared: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      if (/const\s+[A-Z_]*SYSTEM_PROMPT\s*=/.test(readFileSync(path, "utf8"))) declared.push(path.slice(root.length + 1));
    }
  };
  for (const dir of ["service/agents", "service/context", "service/runtime"]) walk(join(root, dir));
  expect(declared.sort()).toEqual([...promptTsFiles].sort());
});

test("prompt strings hardcoded in .ts carry no resurrected dead concepts", () => {
  const bad: string[] = [];
  for (const rel of promptTsFiles) {
    const text = readFileSync(join(root, rel), "utf8");
    for (const pattern of DEAD_PATTERNS) if (pattern.test(text)) bad.push(`${rel}: ${pattern}`);
  }
  expect(bad).toEqual([]);
});
