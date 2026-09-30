import type { Turn, UserInputRecord } from "../types.ts";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { catalog, idPrefix, type IdentityKind } from "../identity/catalog.ts";
export { idPrefix } from "../identity/catalog.ts";

/** Reserve before publishing records; failed operations may leave gaps, never reused IDs. */
export function allocateRecordId(dataDir: string, conversationId: string | null, kind: IdentityKind): string {
  if (catalog[kind].allocation !== "counter") throw new Error(`ID kind ${kind} uses its existing record index`);
  const serviceScoped = catalog[kind].scope === "service";
  if (!serviceScoped && (conversationId === null || !/^[A-Za-z0-9_-]+$/.test(conversationId))) throw new Error("Invalid conversation ID");
  const dir = serviceScoped ? dataDir : join(dataDir, "conversations", conversationId!);
  const path = join(dir, "id-counters.json");
  mkdirSync(dir, { recursive: true });
  let counters: Record<string, number> = {};
  try { counters = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const previous = counters[kind] ?? 0;
  if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER) throw new Error("Invalid ID counter");
  const next = previous + 1;
  counters[kind] = next;
  writeFileSync(`${path}.tmp`, JSON.stringify(counters));
  renameSync(`${path}.tmp`, path);
  return `${idPrefix(kind)}${String(next).padStart(2, "0")}`;
}
/** Service-scoped kinds whose records land on disk as <prefix>_NN.json, so counters can be re-derived from the filesystem. */
const COUNTER_DISK_DIRS: Partial<Record<IdentityKind, (dataDir: string) => string>> = {
  projectMemory: (dataDir) => join(dataDir, "memory", "project"),
};

/**
 * Lift service-scoped counters to the highest ID already on disk. A counter file that is
 * missing or lags behind disk would otherwise re-issue live IDs (memory writes then fail
 * with file_exists because they open files exclusively).
 */
export function calibrateServiceCounters(dataDir: string): Record<string, number> {
  const path = join(dataDir, "id-counters.json");
  let counters: Record<string, number> = {};
  try { counters = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let changed = false;
  for (const [kind, dirOf] of Object.entries(COUNTER_DISK_DIRS) as [IdentityKind, (dataDir: string) => string][]) {
    const dir = dirOf(dataDir);
    if (!existsSync(dir)) continue;
    const prefix = idPrefix(kind);
    let max = 0;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
      const value = Number(name.slice(prefix.length, -".json".length));
      if (Number.isSafeInteger(value) && value > max) max = value;
    }
    if (max > (counters[kind] ?? 0)) { counters[kind] = max; changed = true; }
  }
  if (!changed) return counters;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(counters));
  renameSync(`${path}.tmp`, path);
  return counters;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function pacificDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function nextId(prefix: string, existing: string[]): string {
  let max = 0;
  for (const id of existing) {
    if (!id.startsWith(prefix)) continue;
    const n = Number(id.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(2, "0")}`;
}

/** A turn owns one immutable input; projection and history share its identity. */
export function inputRecord(turn: Pick<Turn, "turnId" | "input">): UserInputRecord {
  return { id: turn.input.id, turnId: turn.turnId, userInput: turn.input.text, submittedAt: turn.input.submittedAt };
}
