import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteConversation, newConversation } from "../runtime/store.ts";
import { loadMemories, saveMemory } from "./store.ts";
import type { MemoryIds, MemoryRecord } from "./types.ts";

const emptyIds = (): MemoryIds => ({ conversation: [], project: [] });
const record = (memoryId: string, layer: MemoryRecord["layer"], text = memoryId, createdAt = "2026-01-01T00:00:00.000Z"): MemoryRecord => ({
  memoryId, turnId: "tn_01", layer, text, createdAt, sourceCallId: "call_01",
});
const withDir = (run: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-long-memory-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
test("long-term records persist outside conversations and load chronologically without ledger project IDs", () => withDir(dir => {
  const first = newConversation(dir).conversationId!;
  const newer = record("lm_newer", "project", "newer", "2026-02-01T00:00:00.000Z");
  const olderB = record("lm_b", "project", "older b");
  const olderA = record("lm_a", "project", "older a");
  for (const item of [newer, olderB, olderA]) saveMemory(dir, first, item);
  const second = newConversation(dir).conversationId!;
  expect(JSON.parse(readFileSync(join(dir, "memory", "project", "lm_newer.json"), "utf8"))).toMatchObject(newer);
  expect(existsSync(join(dir, "conversations", first, "memory", "lm_newer.json"))).toBe(false);
  expect(loadMemories(dir, second, emptyIds()).project.map(item => item.memoryId)).toEqual(["lm_a", "lm_b", "lm_newer"]);
  expect(loadMemories(dir, first, { ...emptyIds(), project: ["stale_ledger_id"] }).project.map(item => item.memoryId)).toEqual(["lm_a", "lm_b", "lm_newer"]);
  deleteConversation(dir, first);
  expect(loadMemories(dir, second, emptyIds()).project.map(item => item.text)).toEqual(["older a", "older b", "newer"]);
}));
