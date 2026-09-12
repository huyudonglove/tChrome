import type { Turn, UserInputRecord } from "../types.ts";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
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
