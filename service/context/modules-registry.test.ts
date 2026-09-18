import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { compressedArchiveFields, compressionArchiveFieldsMarkdown, loadModuleRegistry, registryModules } from "./modules.ts";

const root = resolve(import.meta.dir, "../..");

test("module registry owns consumers, compress flags and archive fields", () => {
  const registry = loadModuleRegistry(root);
  expect(compressedArchiveFields(registry)).toEqual([
    "userInput",
    "goalChanges",
    "pageObservations",
    "memoryWrites",
    "toolIO",
    "queryHistory",
    "output",
  ]);
  const mainSystem = registryModules(registry, { role: "system", consumer: "main" }).map(row => row.id);
  expect(mainSystem).toContain("runtime");
  expect(mainSystem).not.toContain("compressionModules");
  const mainUser = registryModules(registry, { role: "user", consumer: "main" }).map(row => row.id);
  expect(mainUser).toContain("toolIO");
  expect(mainUser).toContain("checklist");
  const md = compressionArchiveFieldsMarkdown(root);
  expect(md).toContain("- toolIO:");
  expect(md).toContain("- pageObservations:");
  expect(md).not.toContain("modules.json");
  expect(md).not.toContain("compress=true");
});
