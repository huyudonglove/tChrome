import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemories, loadMemory, saveMemory } from "./store.ts";
import { projectMemories } from "./window.ts";
import type { Memories, MemoryRecord } from "./types.ts";

const record = (memoryId: string, layer: MemoryRecord["layer"] = "conversation", overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({
  memoryId, turnId: "tn_01", layer, text: `text ${memoryId}`,
  createdAt: "2026-01-01T00:00:00.000Z", sourceCallId: "call_01", ...overrides,
});

test("memory store reads and writes the existing conversation memory path with isolation", () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-memory-"));
  try {
    const path = join(dir, "conversations", "cv_01", "memory", "mem_01.json");
    mkdirSync(join(dir, "conversations", "cv_01", "memory"), { recursive: true });
    const original = record("mem_01");
    writeFileSync(path, JSON.stringify(original));
    expect(loadMemory(dir, "cv_01", "mem_01")).toEqual(original);
    const other = record("mem_01", "conversation", { text: "other conversation" });
    saveMemory(dir, "cv_02", other);
    expect(loadMemory(dir, "cv_02", "mem_01")).toEqual(other);
    expect(loadMemory(dir, "cv_01", "mem_01")).toEqual(original);
    const updated = { ...original, text: "updated" };
    saveMemory(dir, "cv_01", updated);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(updated);
    expect(loadMemory(dir, "cv_02", "mem_01")).toEqual(other);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loading follows ledger IDs and layers without modifying IDs or disk records", () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-memory-"));
  try {
    const records = [record("m1"), record("m2"), record("m3", "conversation"), record("m4", "project")] as const;
    for (const item of records) saveMemory(dir, "cv_01", item);
    const ids = { conversation: ["m2", "m1", "m3"], project: ["m4"] };
    const before = JSON.stringify(ids);
    const memories = loadMemories(dir, "cv_01", ids);
    expect(memories).toEqual({ conversation: [records[1], records[0], records[2]], project: [{ ...records[3], sourceConversationId: "cv_01" }] });
    expect(JSON.stringify(ids)).toBe(before);
    memories.conversation[0]!.text = "in-memory edit";
    expect(loadMemory(dir, "cv_01", "m2")).toEqual(records[1]);
    expect(loadMemories(dir, "cv_01", { conversation: [], project: [] })).toEqual({ conversation: [], project: [{ ...records[3], sourceConversationId: "cv_01" }] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("projection keeps every original memory without metadata, clipping or mutation", () => {
  const memories: Memories = { conversation: [], project: [] };
  for (const layer of ["conversation", "project"] as const) {
    memories[layer] = Array.from({ length: 10 }, (_, i) => record(`${layer}_${i}`, layer, {
      text: `  original\n${"x".repeat(120)} ${i}`,
    }));
  }
  const before = JSON.stringify(memories);
  const projected = projectMemories(memories);
  for (const layer of ["conversation", "project"] as const) {
    expect(JSON.parse(projected[layer])).toEqual(memories[layer].map(item => item.text));
    expect(JSON.parse(projected[layer])).toHaveLength(10);
  }
  expect(JSON.stringify(memories)).toBe(before);
  expect(projectMemories({ conversation: [], project: [] })).toEqual({ conversation: "[]", project: "[]" });
});
