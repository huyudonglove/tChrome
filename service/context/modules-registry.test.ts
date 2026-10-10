import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compressedArchiveFields, compressionArchiveFieldsMarkdown, loadModuleRegistry, registryModules } from "./modules.ts";

const root = resolve(import.meta.dir, "../..");

type RegistryJson = { version: number; modules: { id: string }[] };

const readRegistryJson = (relative: string) =>
  JSON.parse(readFileSync(resolve(root, relative), "utf8")) as RegistryJson;

const skimTags = (overviewBody: string) =>
  [...overviewBody.matchAll(/^- <([A-Za-z][A-Za-z0-9]*)>/gm)].map(m => m[1]!);

const sectionTableIds = (markdown: string, section: string, next: string) => {
  const chunk = markdown.split(section)[1]?.split(next)[0] ?? "";
  return [...chunk.matchAll(/^\| \d+ \| ([A-Za-z][A-Za-z0-9]*) \|/gm)].map(m => m[1]!);
};

test("module registry owns consumers and archive fields", () => {
  const registry = loadModuleRegistry(root);
  expect(compressedArchiveFields(registry)).toEqual(["loops"]);
  const mainSystem = registryModules(registry, { role: "system", consumer: "main" }).map(row => row.id);
  expect(mainSystem).toContain("runtimeProtocol");
  expect(mainSystem).not.toContain("runtimeNotices");
  expect(mainSystem).not.toContain("compressionModules");
  const mainUser = registryModules(registry, { role: "user", consumer: "main" }).map(row => row.id);
  expect(mainUser).toEqual(["skill", "projectMemory", "tools", "conversation", "contextUsage"]);
  const md = compressionArchiveFieldsMarkdown(root);
  expect(md).toContain("- loops:");
  expect(md).toContain("callId");
  expect(md).not.toContain("modules.json");
  expect(md).not.toContain("archiveField");
});

test("overview skims and README tables match registries; hierarchy tags stay in registry", () => {
  const main = loadModuleRegistry(root);
  const mainModules = registryModules(main, { consumer: "main" }).map(row => row.id);
  const mainSystem = registryModules(main, { role: "system", consumer: "main" }).map(row => row.id);
  const mainUser = registryModules(main, { role: "user", consumer: "main" }).map(row => row.id);
  const mainSkim = skimTags(readFileSync(resolve(root, "service/context/system/overview.md"), "utf8"));
  // overview 不再重复模块清单：模块集合的唯一来源是 modules.json。
  expect(mainSkim).toEqual([]);
  expect(mainModules).toContain("overview");

  const compressionRegistry = readRegistryJson("service/agents/compression/context/modules.json");
  const queryRegistry = readRegistryJson("service/agents/query/context/modules.json");
  const compressionSkim = skimTags(readFileSync(resolve(root, "service/agents/compression/context/system/overview.md"), "utf8"));
  const querySkim = skimTags(readFileSync(resolve(root, "service/agents/query/context/system/overview.md"), "utf8"));
  // 子代理 overview 同样不再重复模块清单：模块集合的唯一来源是各自 modules.json。
  expect(compressionSkim).toEqual([]);
  expect(querySkim).toEqual([]);
  expect(compressionRegistry.modules.map(row => row.id)).toContain("overview");
  expect(queryRegistry.modules.map(row => row.id)).toContain("overview");

  const readme = readFileSync(resolve(root, "service/context/README.md"), "utf8");
  expect(new Set(sectionTableIds(readme, "### System", "### User"))).toEqual(new Set(mainSystem));
  expect(new Set(sectionTableIds(readme, "### User", "### Archive"))).toEqual(new Set(mainUser));

  
});
