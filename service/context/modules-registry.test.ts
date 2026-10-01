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

test("module registry owns consumers, compress flags and archive fields", () => {
  const registry = loadModuleRegistry(root);
  expect(compressedArchiveFields(registry)).toEqual([
    "userInput",
    "toolIO",
    "observations",
    "memoryWrites",
    "reflection",
    "queryHistory",
    "stopReason",
    "actions",
  ]);
  const mainSystem = registryModules(registry, { role: "system", consumer: "main" }).map(row => row.id);
  expect(mainSystem).toContain("runtime");
  expect(mainSystem).not.toContain("compressionModules");
  const mainUser = registryModules(registry, { role: "user", consumer: "main" }).map(row => row.id);
  expect(mainUser).toEqual(["skill", "projectMemory", "tools", "conversation"]);
  const md = compressionArchiveFieldsMarkdown(root);
  expect(md).toContain("- toolIO:");
  expect(md).toContain("- observations:");
  expect(md).toContain("return:{stage,result}");
  expect(md).toContain("只存指针");
  expect(md).not.toContain("modules.json");
  expect(md).not.toContain("compress=true");
});

test("overview skims and README tables match registries; hierarchy tags stay in registry", () => {
  const main = loadModuleRegistry(root);
  const mainModules = registryModules(main, { consumer: "main" }).map(row => row.id);
  const mainSystem = registryModules(main, { role: "system", consumer: "main" }).map(row => row.id);
  const mainUser = registryModules(main, { role: "user", consumer: "main" }).map(row => row.id);
  const mainSkim = skimTags(readFileSync(resolve(root, "service/context/system/overview.md"), "utf8"));
  expect(new Set(mainSkim)).toEqual(new Set(mainModules.filter(id => id !== "overview")));

  const compressionRegistry = readRegistryJson("service/agents/compression/context/modules.json");
  const queryRegistry = readRegistryJson("service/agents/query/context/modules.json");
  const compressionIds = compressionRegistry.modules.map(row => row.id);
  const queryIds = queryRegistry.modules.map(row => row.id);
  const compressionSkim = skimTags(readFileSync(resolve(root, "service/agents/compression/context/system/overview.md"), "utf8"));
  const querySkim = skimTags(readFileSync(resolve(root, "service/agents/query/context/system/overview.md"), "utf8"));
  expect(new Set(compressionSkim)).toEqual(new Set(compressionIds.filter(id => id !== "overview")));
  expect(new Set(querySkim)).toEqual(new Set(queryIds.filter(id => id !== "overview")));

  const readme = readFileSync(resolve(root, "service/context/README.md"), "utf8");
  expect(new Set(sectionTableIds(readme, "### System", "### User"))).toEqual(new Set(mainSystem));
  expect(new Set(sectionTableIds(readme, "### User", "### Archive"))).toEqual(new Set(mainUser));

  
});
