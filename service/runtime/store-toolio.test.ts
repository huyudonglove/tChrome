import { test, expect } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolIOItem } from "../types.ts";
import { loadLedger, loadToolRows, newConversation, paths, saveLedger } from "./store";

const makeRow = (callId: string, text: string): ToolIOItem => ({
  callId,
  name: "local_run",
  arguments: { reason: "probe", command: "echo hi" },
  turnId: "tn_01",
  return: { stage: "complete", totalChars: text.length, text },
});

/** newConversation returns a SessionView whose conversationId is nullable in the type; tests always have one. */
const newCv = (dataDir: string): string => newConversation(dataDir).conversationId!;

/** Copy a conversation's toolio files into a fresh dataDir so the read path starts from disk. */
const cloneForRead = (source: string, dataDir: string, cvId: string): void => {
  const src = paths(source, cvId);
  const dir = join(dataDir, "conversations", cvId);
  mkdirSync(dir, { recursive: true });
  // Archives written before the toolio/ subdirectory existed still sit flat in the root.
  for (const name of readdirSync(src.conv)) {
    if (name.startsWith("toolio") && name.endsWith(".jsonl")) copyFileSync(join(src.conv, name), join(dir, name));
  }
  if (existsSync(src.toolioDir)) {
    mkdirSync(join(dir, "toolio"), { recursive: true });
    for (const name of readdirSync(src.toolioDir)) copyFileSync(join(src.toolioDir, name), join(dir, "toolio", name));
  }
};

const lines = (dataDir: string, cvId: string): { k: string }[] =>
  readFileSync(paths(dataDir, cvId).toolio, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { k: string });

test("toolIO rows append to toolio.jsonl and leave ledger.json state-only", () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-toolio-"));
  try {
    const cvId = newCv(dir);
    const ledger = loadLedger(dir, cvId);
    ledger.toolIO.push(makeRow("call_01", "first"));
    saveLedger(dir, ledger);
    expect(existsSync(paths(dir, cvId).toolio)).toBe(true);
    expect(JSON.parse(readFileSync(paths(dir, cvId).ledger, "utf8")).toolIO).toBeUndefined();
    expect(loadToolRows(dir, cvId).map((row) => row.callId)).toEqual(["call_01"]);

    const second = loadLedger(dir, cvId);
    second.toolIO.push(makeRow("call_02", "second"));
    saveLedger(dir, second);
    expect(loadToolRows(dir, cvId).map((row) => row.callId)).toEqual(["call_01", "call_02"]);
    expect(lines(dir, cvId).map((line) => line.k)).toEqual(["row", "row"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a rewritten return appends one amend line and wins when read back from disk", () => {
  const source = mkdtempSync(join(tmpdir(), "tchrome-toolio-src-"));
  const fresh = mkdtempSync(join(tmpdir(), "tchrome-toolio-read-"));
  try {
    const cvId = newCv(source);
    const ledger = loadLedger(source, cvId);
    ledger.toolIO.push({ ...makeRow("call_01", "original"), runtimeHints: ["runtime[repeat:call] repeated"], imagesError: "invalid PNG signature" });
    saveLedger(source, ledger);

    // Mirrors the saveFullReturn / nudge-strip paths: mutate the row in place, then save.
    const reloaded = loadLedger(source, cvId);
    const row = reloaded.toolIO.find((item) => item.callId === "call_01");
    if (!row) throw new Error("row missing");
    row.return = { stage: "complete", totalChars: 8, text: "replaced" };
    saveLedger(source, reloaded);
    expect(lines(source, cvId).map((line) => line.k)).toEqual(["row", "amend"]);

    cloneForRead(source, fresh, cvId);
    const rows = loadToolRows(fresh, cvId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.return.text).toBe("replaced");
    expect(rows[0]!.runtimeHints).toEqual(["runtime[repeat:call] repeated"]);
    expect(rows[0]!.imagesError).toBe("invalid PNG signature");
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
});

test("rotation moves the active file aside and the read path merges archive + active", () => {
  const source = mkdtempSync(join(tmpdir(), "tchrome-toolio-rot-"));
  const fresh = mkdtempSync(join(tmpdir(), "tchrome-toolio-rot-read-"));
  try {
    const cvId = newCv(source);
    const big = "A".repeat(3_200_000); // over the 3 MiB rotate threshold
    const ledger = loadLedger(source, cvId);
    ledger.toolIO.push(makeRow("call_01", big));
    saveLedger(source, ledger);
    expect(existsSync(paths(source, cvId).toolio)).toBe(true);

    const again = loadLedger(source, cvId);
    const row = again.toolIO.find((item) => item.callId === "call_01");
    if (!row) throw new Error("row missing");
    row.return = { stage: "complete", totalChars: 9, text: "B".repeat(9) };
    saveLedger(source, again);
    expect(existsSync(join(paths(source, cvId).toolioDir, "toolio.01.jsonl"))).toBe(true);

    cloneForRead(source, fresh, cvId);
    const rows = loadToolRows(fresh, cvId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.return.text).toBe("B".repeat(9));
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
});

test("a torn trailing line is skipped instead of failing the whole read", () => {
  const source = mkdtempSync(join(tmpdir(), "tchrome-toolio-torn-"));
  const fresh = mkdtempSync(join(tmpdir(), "tchrome-toolio-torn-read-"));
  try {
    const cvId = newCv(source);
    mkdirSync(paths(source, cvId).toolioDir, { recursive: true });
    writeFileSync(
      paths(source, cvId).toolio,
      `${JSON.stringify({ k: "row", row: makeRow("call_01", "ok") })}\n{"k":"row","row":{"callId":"call_02"`,
    );
    // Read from a separate dataDir: the row cache is process-wide, so the same
    // key would already be populated by newConversation and never hit disk.
    cloneForRead(source, fresh, cvId);
    expect(loadToolRows(fresh, cvId).map((row) => row.callId)).toEqual(["call_01"]);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
});