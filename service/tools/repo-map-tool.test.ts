import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRepoMap } from "./repo-map-tool.ts";

let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "repo-map-tool-"));
  await mkdir(join(root, "core", "runtime"), { recursive: true });
  await mkdir(join(root, "ui"), { recursive: true });
  await writeFile(
    join(root, "core", "runtime", "engine.ts"),
    [
      "export function startEngine() {",
      "  return 1;",
      "}",
      "export interface EngineOptions {",
      "  verbose?: boolean;",
      "}",
      "export const engineGate = 2;",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(root, "core", "runtime", "types.ts"),
    ["export type EngineMode = \"a\" | \"b\";", "export class EngineState {}"].join("\n"),
    "utf8",
  );
  await writeFile(
    join(root, "ui", "panel.ts"),
    ["export function renderPanel() {", "  return 2;", "}"].join("\n"),
    "utf8",
  );
  await writeFile(join(root, "ui", "style.css"), "body { margin: 0; }", "utf8");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("directories mode aggregates by directory with entry file hints", async () => {
  const result = (await runRepoMap({ path: root, mode: "directories" })) as unknown as {
    ok: boolean;
    mode: string;
    totals: { files: number; symbols: number };
    totalDirs: number;
    directories: { dir: string; files: number; symbols: number; topFiles: { path: string; symbols: string[] }[] }[];
  };
  expect(result.ok).toBe(true);
  expect(result.mode).toBe("directories");
  expect(result.totals.files).toBe(3);
  expect(result.totals.symbols).toBe(6);

  const core = result.directories.find((item) => item.dir === "core/runtime");
  expect(core).toBeDefined();
  expect(core!.files).toBe(2);
  expect(core!.topFiles[0]!.path).toBe("core/runtime/engine.ts");
  expect(core!.topFiles[0]!.symbols).toContain("function startEngine");
});

test("directories mode reports truncation when maxDirs is exceeded", async () => {
  const result = (await runRepoMap({ path: root, mode: "directories", maxDirs: 1 })) as unknown as {
    ok: boolean;
    totalDirs: number;
    directories: unknown[];
    truncated: boolean;
    note: string;
  };
  expect(result.totalDirs).toBe(2);
  expect(result.directories).toHaveLength(1);
  expect(result.truncated).toBe(true);
  expect(result.note).toContain("maxDirs=1");
});

test("map mode returns the rendered symbol topology", async () => {
  const result = (await runRepoMap({ path: root, mode: "map" })) as unknown as {
    ok: boolean;
    mode: string;
    renderedMap: string;
  };
  expect(result.ok).toBe(true);
  expect(result.mode).toBe("map");
  expect(result.renderedMap).toContain("startEngine");
  expect(result.renderedMap).toContain("renderPanel");
});

test("missing path and unresolvable path fail with actionable notes", async () => {
  const missing = (await runRepoMap({})) as { ok: boolean; error: string };
  expect(missing.ok).toBe(false);
  expect(missing.error).toContain("path");

  const bad = (await runRepoMap({ path: join(root, "does-not-exist"), mode: "map" })) as {
    ok: boolean;
    error: string;
    note: string;
  };
  expect(bad.ok).toBe(false);
  expect(bad.note).toContain("local.fs_outline");
});
