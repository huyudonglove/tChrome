import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodeRefs } from "./code-refs.ts";

let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "code-refs-"));
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(
    join(root, "alpha.ts"),
    [
      "export function alphaGate(value: string) {",
      "  return value.trim();",
      "}",
      "const local = alphaGate('x');",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(root, "nested", "beta.ts"),
    ["export const alphaGate = 1;", "export type AlphaGateShape = { alphaGate?: string };"].join("\n"),
    "utf8",
  );
  await writeFile(join(root, "notes.txt"), "alphaGate appears here but not code", "utf8");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("returns both definitions and references for a known symbol", async () => {
  const result = (await runCodeRefs({ path: root, symbol: "alphaGate" })) as unknown as {
    ok: boolean;
    counts: { definitions: number; references: number };
    definitions: { path: string; line: number; kind: string }[];
    references: { path: string; line: number }[];
  };
  expect(result.ok).toBe(true);
  expect(result.counts.definitions).toBe(2);
  expect(result.counts.references).toBe(2);
  expect(result.definitions.map((item) => item.kind).sort()).toEqual(["const", "function"]);
  expect(result.definitions.every((item) => item.line >= 1)).toBe(true);
  expect(result.references[0]!.line).toBe(4);
});

test("skips non-code files but still reports scanned file count", async () => {
  const result = (await runCodeRefs({ path: root, symbol: "alphaGate" })) as { scannedFiles: number };
  expect(result.scannedFiles).toBe(2);
});

test("kind filter narrows definitions", async () => {
  const result = (await runCodeRefs({ path: root, symbol: "alphaGate", kind: "function" })) as unknown as {
    counts: { definitions: number };
    definitions: { kind: string }[];
  };
  expect(result.counts.definitions).toBe(1);
  expect(result.definitions[0]!.kind).toBe("function");
});

test("missing symbol reports ok=false with an actionable note", async () => {
  const result = (await runCodeRefs({ path: root, symbol: "noSuchSymbolHere" })) as {
    ok: boolean;
    note?: string;
    definitions: unknown[];
  };
  expect(result.ok).toBe(false);
  expect(result.definitions).toEqual([]);
  expect(result.note).toContain("无匹配");
});

test("accepts a single file path", async () => {
  const result = (await runCodeRefs({ path: join(root, "alpha.ts"), symbol: "alphaGate" })) as {
    counts: { definitions: number };
    scannedFiles: number;
  };
  expect(result.scannedFiles).toBe(1);
  expect(result.counts.definitions).toBe(1);
});

test("rejects empty path or symbol", async () => {
  await expect(runCodeRefs({ path: "", symbol: "alphaGate" })).rejects.toThrow("path is required");
  await expect(runCodeRefs({ path: root, symbol: "" })).rejects.toThrow("symbol is required");
});
