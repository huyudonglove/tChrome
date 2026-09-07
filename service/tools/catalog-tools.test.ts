import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadCatalog } from "../prompt/catalog.ts";

const repoRoot = join(import.meta.dir, "../..");

test("每个工具有 schema，reason 和 affectsPage 都在 required", () => {
  const catalog = loadCatalog(repoRoot);
  const listed = [...catalog.index.browser, ...catalog.index.service, ...catalog.assemble.baseToolsIds];
  const unique = [...new Set(listed)];
  expect(unique.length).toBeGreaterThan(20);
  for (const name of unique) {
    const tool = catalog.tools[name];
    expect(tool, name).toBeTruthy();
    if (!tool) continue;
    const params = tool.function.parameters as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(params.properties?.reason, `${name} reason`).toBeTruthy();
    expect(params.properties?.affectsPage, `${name} affectsPage`).toBeTruthy();
    expect(params.required ?? [], `${name} required`).toContain("reason");
    expect(params.required ?? [], `${name} required`).toContain("affectsPage");
    expect(tool.function.name).toBe(name);
    expect(catalog.index.usage[name] || catalog.assemble.baseToolsIds.includes(name), `${name} usage`).toBeTruthy();
  }
  for (const name of catalog.assemble.coreToolIds) {
    expect(catalog.tools[name], `core ${name}`).toBeTruthy();
  }
});

test("core 工具 schema 带上用法里的必填入参", () => {
  const catalog = loadCatalog(repoRoot);
  const requiredOf = (name: string) => {
    const params = catalog.tools[name]?.function.parameters as { required?: string[] };
    return params.required ?? [];
  };
  expect(requiredOf("page.click")).toContain("id");
  expect(requiredOf("page.type")).toEqual(expect.arrayContaining(["id", "text"]));
  expect(requiredOf("open_url")).toContain("url");
  expect(requiredOf("web_search")).toContain("query");
  expect(requiredOf("submitGoal")).toContain("goal");
  expect(requiredOf("catalog.add")).toContain("names");
  expect(requiredOf("askUser")).toContain("choice");
});
