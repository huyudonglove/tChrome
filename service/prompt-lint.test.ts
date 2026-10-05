import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadToolRegistry } from "./tools/registry.ts";

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
