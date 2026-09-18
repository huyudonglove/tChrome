import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  compressionArchiveFields,
  compressionModulesMarkdown,
  loadCompressionInventory,
  uncompressedWindowSlots,
} from "./compression-inventory.ts";
import { compressionSystemPrompt } from "../agents/compression/protocol.ts";

const repoRoot = resolve(import.meta.dir, "../..");

test("inventory is the single source for compressed archive fields and idle window slots", () => {
  const inventory = loadCompressionInventory(repoRoot);
  expect(compressionArchiveFields(inventory)).toEqual([
    "userInput",
    "goalChanges",
    "toolIO",
    "pageObservations",
    "memoryWrites",
    "queryHistory",
    "output",
  ]);
  expect(uncompressedWindowSlots(inventory)).toContain("skill");
  expect(uncompressedWindowSlots(inventory)).toContain("checklist");
  expect(uncompressedWindowSlots(inventory)).toContain("currentQuery");
  const markdown = compressionModulesMarkdown(inventory);
  expect(markdown).toContain("- toolIO:");
  expect(markdown).toContain("- pageObservations:");
  expect(markdown).not.toContain("- notes:");
  expect(markdown).toContain("#skill");
});

test("compression system prompt injects inventory modules instead of a hand-written list", () => {
  const system = compressionSystemPrompt(repoRoot);
  expect(system).toContain("我是历史压缩 Agent");
  expect(system).toContain("compression-inventory.json");
  expect(system).toContain("- toolIO:");
  expect(system).toContain("submitTurnSummaries");
  expect(system).not.toContain("## 模块清单");
});
