import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemories, loadMemory, migrateConversationMemory, saveMemory } from "./store.ts";
import { projectMemories } from "./window.ts";
import type { Memories, MemoryRecord } from "./types.ts";

const record = (memoryId: string, layer: MemoryRecord["layer"] = "conversation", overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({
  memoryId, layer, text: `text ${memoryId}`, summary: `summary ${memoryId}`,
  compressed: false, createdAt: "2026-01-01T00:00:00.000Z", sourceCallId: "call_01", ...overrides,
});

test("memory store reads and writes the existing conversation memory path with isolation", () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-memory-"));
  try {
    const path = join(dir, "conversations", "cv_01", "memory", "mem_01.json");
    mkdirSync(join(dir, "conversations", "cv_01", "memory"), { recursive: true });
    const legacy = record("mem_01");
    writeFileSync(path, JSON.stringify(legacy));
    expect(loadMemory(dir, "cv_01", "mem_01")).toEqual(legacy);
    const other = record("mem_01", "conversation", { text: "other conversation" });
    saveMemory(dir, "cv_02", other);
    expect(loadMemory(dir, "cv_02", "mem_01")).toEqual(other);
    expect(loadMemory(dir, "cv_01", "mem_01")).toEqual(legacy);
    const updated = { ...legacy, text: "updated" };
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

test("projection keeps the latest eight entries in original order for every layer", () => {
  const memories: Memories = { conversation: [], project: [] };
  for (const layer of ["conversation", "project"] as const) {
    memories[layer] = Array.from({ length: 10 }, (_, i) => record(`${layer}_${i}`, layer, { compressed: i === 8 }));
  }
  const before = JSON.stringify(memories);
  const result = projectMemories(memories);
  for (const layer of ["conversation", "project"] as const) {
    expect(result[layer]).toBe(Array.from({ length: 8 }, (_, offset) => {
      const i = offset + 2;
      return `${i === 8 ? "summary" : "text"} ${layer}_${i}`;
    }).join("\n"));
  }
  expect(JSON.stringify(memories)).toBe(before);
});

test("compact projection summarizes conversation only without mutating stored content", () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-memory-"));
  try {
    const longText = `  alpha\n\t beta  ${"x".repeat(100)}`;
    const memories: Memories = { conversation: [], project: [] };
    for (const layer of ["conversation", "project"] as const) {
      memories[layer] = [
        record(`${layer}_1`, layer, { text: longText, summary: "" }),
        record(`${layer}_2`, layer, { text: "full text", summary: "short summary" }),
        record(`${layer}_3`, layer, { text: "compressed full text", summary: "compressed summary", compressed: true }),
      ];
      for (const item of memories[layer]) saveMemory(dir, "cv_01", item);
    }
    const before = JSON.stringify(memories);
    const projected = projectMemories(memories, true);
    const compact = `${longText.replace(/\s+/g, " ").trim().slice(0, 80)}\nshort summary\ncompressed summary`;
    expect(projected.conversation).toBe(compact);
    expect(projected.project).toBe(`${longText}\nfull text\ncompressed summary`);
    expect(JSON.stringify(memories)).toBe(before);
    for (const items of Object.values(memories)) {
      for (const item of items) expect(loadMemory(dir, "cv_01", item.memoryId)).toEqual(item.layer === "project" ? { ...item, sourceConversationId: "cv_01" } : item);
    }
    expect(projectMemories({ conversation: [], project: [] }, true)).toEqual({ conversation: "", project: "" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("legacy process records normalize on read and merge chronologically without loss", () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-memory-"));
  try {
    const folder = join(dir, "conversations", "cv_01", "memory");
    mkdirSync(folder, { recursive: true });
    const older = { ...record("mm_20", "conversation", { createdAt: "2025-12-01T00:00:00.000Z" }), layer: "turn" };
    const tieEarly = { ...record("mm_2"), layer: "turn" };
    const tieLate = record("mm_10");
    const newer = record("mm_1", "conversation", { createdAt: "2026-02-01T00:00:00.000Z" });
    const records = [older, tieEarly, tieLate, newer];
    for (const item of records) writeFileSync(join(folder, `${item.memoryId}.json`), JSON.stringify(item));
    expect(loadMemory(dir, "cv_01", "mm_20")).toEqual({ ...older, layer: "conversation" });
    const ids = { turn: ["mm_2", "mm_20", "mm_2"], conversation: ["mm_1", "mm_10", "mm_2"], project: ["legacy_project"] };
    const before = JSON.stringify(ids);
    const merged = migrateConversationMemory(dir, "cv_01", ids);
    expect(merged).toEqual({ conversation: ["mm_20", "mm_2", "mm_10", "mm_1"], project: ["legacy_project"] });
    expect(JSON.stringify(ids)).toBe(before);
    const content = records.map(item => readFileSync(join(folder, `${item.memoryId}.json`), "utf8"));
    for (const [i, item] of records.entries()) expect(JSON.parse(content[i]!)).toEqual({ ...item, layer: "conversation" });
    expect(migrateConversationMemory(dir, "cv_01", ids)).toEqual(merged);
    expect(migrateConversationMemory(dir, "cv_01", merged)).toEqual(merged);
    expect(records.map(item => readFileSync(join(folder, `${item.memoryId}.json`), "utf8"))).toEqual(content);
    expect(loadMemories(dir, "cv_01", merged).conversation).toEqual(records.map(item => ({ ...item, layer: "conversation" })));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
