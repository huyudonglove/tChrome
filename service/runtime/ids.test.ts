import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateRecordId, calibrateServiceCounters } from "./ids.ts";

const readCounters = (dir: string): Record<string, number> => JSON.parse(readFileSync(join(dir, "id-counters.json"), "utf8"));

const seedMemory = (dir: string, ids: number[]): void => {
  const project = join(dir, "memory", "project");
  mkdirSync(project, { recursive: true });
  for (const id of ids) writeFileSync(join(project, `lm_${String(id).padStart(2, "0")}.json`), "{}");
};

test("lifts a counter that lags behind the records on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-ids-"));
  try {
    seedMemory(dir, [1, 2, 14]);
    writeFileSync(join(dir, "id-counters.json"), JSON.stringify({ projectMemory: 3 }));
    expect(calibrateServiceCounters(dir).projectMemory).toBe(14);
    expect(readCounters(dir).projectMemory).toBe(14);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rebuilds a missing counter file from disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-ids-"));
  try {
    seedMemory(dir, [7]);
    expect(calibrateServiceCounters(dir).projectMemory).toBe(7);
    expect(readCounters(dir).projectMemory).toBe(7);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("leaves counters that already lead the disk untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-ids-"));
  try {
    seedMemory(dir, [2]);
    const before = JSON.stringify({ projectMemory: 9, bridge: 218 });
    writeFileSync(join(dir, "id-counters.json"), before);
    expect(calibrateServiceCounters(dir)).toEqual({ projectMemory: 9, bridge: 218 });
    expect(readFileSync(join(dir, "id-counters.json"), "utf8")).toBe(before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unrelated files in the memory directory are ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-ids-"));
  try {
    const project = join(dir, "memory", "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "lm_05.json"), "{}");
    writeFileSync(join(project, "lm_notes.json"), "{}");
    writeFileSync(join(project, "README.md"), "");
    expect(calibrateServiceCounters(dir).projectMemory).toBe(5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the next project memory ID does not collide after calibrating", () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-ids-"));
  try {
    seedMemory(dir, [1, 2, 3]);
    writeFileSync(join(dir, "id-counters.json"), JSON.stringify({ projectMemory: 3 }));
    calibrateServiceCounters(dir);
    const next = allocateRecordId(dir, null, "projectMemory");
    expect(next).toBe("lm_04");
    expect(() => writeFileSync(join(dir, "memory", "project", `${next}.json`), "{}", { flag: "wx" })).not.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
