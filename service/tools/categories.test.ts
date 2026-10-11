import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCategories } from "./capability.ts";
import { dynamicToolIds, loadToolRegistry, toolCategoryGuide } from "./registry.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const ids = ["a", "b", "c"];

function writeCategories(content: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "tchrome-categories-"));
  mkdirSync(join(root, "service/capabilities"), { recursive: true });
  writeFileSync(join(root, "service/capabilities/categories.json"), JSON.stringify(content));
  return root;
}

test("categories load in file order and cover every dynamic tool exactly once", () => {
  const root = writeCategories({
    version: 1,
    categories: [
      { id: "one", label: "第一类", purpose: "第一", tools: ["a", "b"] },
      { id: "two", label: "第二类", purpose: "第二", tools: ["c"] },
    ],
  });
  const rows = loadCategories(root, ids);
  expect(rows.map((row) => row.label)).toEqual(["第一类", "第二类"]);
  expect(rows[1]!.tools).toEqual(["c"]);
});

test("categories reject unknown, missing, duplicated and malformed entries", () => {
  const cases: unknown[] = [
    { version: 1, categories: [{ id: "one", label: "L", purpose: "P", tools: ["a", "b", "z"] }] },
    { version: 1, categories: [{ id: "one", label: "L", purpose: "P", tools: ["a"] }] },
    {
      version: 1,
      categories: [
        { id: "one", label: "L", purpose: "P", tools: ["a", "b"] },
        { id: "two", label: "L", purpose: "P", tools: ["b", "c"] },
      ],
    },
    { version: 1, categories: [{ id: "one", label: "L", purpose: "P", tools: ["a", "a", "b", "c"] }] },
    { version: 1, categories: [{ id: "one", label: "  ", purpose: "P", tools: ["a", "b", "c"] }] },
    { version: 1, categories: [{ id: "one", label: "L", purpose: "P", tools: "abc" }] },
    { version: 1, categories: [] },
    { version: 2, categories: [{ id: "one", label: "L", purpose: "P", tools: ["a", "b", "c"] }] },
  ];
  for (const content of cases) expect(() => loadCategories(writeCategories(content), ids)).toThrow();
});

test("repo categories partition every dynamic tool exactly once", () => {
  const registry = loadToolRegistry(repoRoot);
  const all = dynamicToolIds(registry);
  const seen = new Set<string>();
  for (const category of registry.categories) {
    for (const id of category.tools) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  }
  expect(all.every((id) => seen.has(id))).toBe(true);
  expect(seen.size).toBe(all.length);
});

test("toolCategoryGuide lists unloaded members per category and is empty when all are loaded", () => {
  const registry = loadToolRegistry(repoRoot);
  const all = dynamicToolIds(registry);
  const guide = toolCategoryGuide(registry, []);
  expect(guide).toContain(registry.categories[0]!.label);
  expect(guide).toContain(registry.categories[0]!.tools[0]!);
  expect(guide).toContain(`（${registry.categories[0]!.tools.length}）`);
  expect(toolCategoryGuide(registry, all)).toBe("");
});
