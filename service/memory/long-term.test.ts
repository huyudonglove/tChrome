import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteConversation, newConversation } from "../runtime/store.ts";
import { loadMemories, migrateProjectMemories, saveMemory } from "./store.ts";
import type { MemoryIds, MemoryRecord } from "./types.ts";

const emptyIds = (): MemoryIds => ({ conversation: [], project: [] });
const record = (memoryId: string, layer: MemoryRecord["layer"], text = memoryId, createdAt = "2026-01-01T00:00:00.000Z"): MemoryRecord => ({
  memoryId, layer, text, summary: text, compressed: false, createdAt, sourceCallId: "call_01",
});
const withDir = (run: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-long-memory-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
function legacyMemory(dir: string, conversationId: string, item: MemoryRecord): string {
  const folder = join(dir, "conversations", conversationId, "memory");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${item.memoryId}.json`);
  writeFileSync(path, JSON.stringify(item));
  return path;
}

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

test("legacy migration preserves colliding per-conversation IDs and originals and is idempotent", () => withDir(dir => {
  const first = newConversation(dir).conversationId!;
  const second = newConversation(dir).conversationId!;
  const a = record("mm_01", "project", "first long-term fact");
  const b = record("mm_01", "project", "second long-term fact");
  const pathA = legacyMemory(dir, first, a);
  const pathB = legacyMemory(dir, second, b);
  legacyMemory(dir, first, record("mm_02", "conversation", "private fact"));
  migrateProjectMemories(dir);
  const expected = [
    { ...a, memoryId: `legacy_${first}_mm_01`, sourceConversationId: first },
    { ...b, memoryId: `legacy_${second}_mm_01`, sourceConversationId: second },
  ];
  expect(loadMemories(dir, second, emptyIds()).project).toEqual(expected);
  expect(JSON.parse(readFileSync(pathA, "utf8"))).toEqual(a);
  expect(JSON.parse(readFileSync(pathB, "utf8"))).toEqual(b);
  const before = readdirSync(join(dir, "memory", "project")).sort().map(name => [name, readFileSync(join(dir, "memory", "project", name), "utf8")]);
  migrateProjectMemories(dir);
  expect(readdirSync(join(dir, "memory", "project")).sort().map(name => [name, readFileSync(join(dir, "memory", "project", name), "utf8")])).toEqual(before);
  expect(loadMemories(dir, first, emptyIds()).project).toEqual(expected);
}));

test("deleting an unread legacy conversation migrates its long-term facts before removing it", () => withDir(dir => {
  const first = newConversation(dir).conversationId!;
  const fact = record("mm_01", "project", "retain after deletion");
  legacyMemory(dir, first, fact);
  const second = newConversation(dir).conversationId!;
  deleteConversation(dir, first);
  expect(existsSync(join(dir, "conversations", first))).toBe(false);
  expect(loadMemories(dir, second, emptyIds()).project).toEqual([
    { ...fact, memoryId: `legacy_${first}_mm_01`, sourceConversationId: first },
  ]);
}));

test("loading migrates legacy long-term facts but retains conversation isolation", () => withDir(dir => {
  const first = newConversation(dir).conversationId!;
  const second = newConversation(dir).conversationId!;
  const shared = record("mm_03", "project", "shared");
  legacyMemory(dir, first, shared);
  for (const [conversationId, label] of [[first, "first"], [second, "second"]]) {
    saveMemory(dir, conversationId!, record("mm_01", "conversation", `${label} process fact`));
    saveMemory(dir, conversationId!, record("mm_02", "conversation", `${label} conversation`));
  }
  const ids = { conversation: ["mm_01", "mm_02"], project: [] };
  const a = loadMemories(dir, first, ids);
  const b = loadMemories(dir, second, ids);
  expect(a.conversation.map(item => item.text)).toEqual(["first process fact", "first conversation"]);
  expect(b.conversation.map(item => item.text)).toEqual(["second process fact", "second conversation"]);
  expect(a.project).toEqual(b.project);
  expect(b.project).toEqual([{ ...shared, memoryId: `legacy_${first}_mm_03`, sourceConversationId: first }]);
  expect(loadMemories(dir, second, emptyIds()).conversation).toEqual([]);
}));
