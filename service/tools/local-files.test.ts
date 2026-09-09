import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLocalFileTool as run } from "./local-files.ts";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "tchrome-fs-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test("writes and appends files; UTF-8 byte pagination preserves complete characters", async () => {
  const path = join(root, "text.txt");
  expect(await run("local.fs_write", { path, content: "abc你好世界" })).toMatchObject({ ok: true, bytesWritten: 15 });
  expect(await run("local.fs_write", { path, content: "!", append: true })).toMatchObject({ ok: true });
  let offset = 0;
  let content = "";
  for (let page = 0; page < 10; page++) {
    const result = await run("local.fs_read", { path, offset, limit: 4 });
    expect(result.ok).toBe(true);
    content += result.content;
    offset = result.nextOffset as number;
    if (!result.truncated) break;
  }
  expect(content).toBe("abc你好世界!");
  expect(offset).toBe(16);
  expect(await run("local.fs_read", { path: root })).toMatchObject({ ok: false });
  expect(await run("local.fs_read", { path, offset: 100 })).toMatchObject({ content: "", truncated: false });
});

test("copy and move reject existing destinations by default without changing source", async () => {
  const source = join(root, "source");
  const destination = join(root, "destination");
  await writeFile(source, "source");
  await writeFile(destination, "existing");
  for (const name of ["local.fs_copy", "local.fs_move"]) {
    expect(await run(name, { source, destination })).toMatchObject({ ok: false });
    expect(await readFile(source, "utf8")).toBe("source");
    expect(await readFile(destination, "utf8")).toBe("existing");
  }
  expect(await run("local.fs_copy", { source, destination, overwrite: true })).toMatchObject({ ok: true });
  expect(await readFile(destination, "utf8")).toBe("source");
  const moved = join(root, "moved");
  expect(await run("local.fs_move", { source, destination: moved })).toMatchObject({ ok: true });
  expect(await run("local.fs_stat", { path: source })).toMatchObject({ ok: false });
  expect(await readFile(moved, "utf8")).toBe("source");
  await mkdir(join(root, "a"));
  await mkdir(join(root, "b"));
  expect(await run("local.fs_copy", { source: join(root, "a"), destination: join(root, "b") })).toMatchObject({ ok: false });
});

test("search traverses nested directories with bounds, never follows directory symlinks", async () => {
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "match.txt"), "yes");
  await symlink(root, join(root, "nested", "loop"));
  const result = await run("local.fs_search", { path: root, query: "match" });
  expect(result).toMatchObject({ ok: true, scanned: 3, truncated: false, matches: [{ name: "match.txt", path: join(root, "nested", "match.txt"), type: "file" }] });
  expect(await run("local.fs_search", { path: root, query: "match", maxEntries: 1 })).toMatchObject({ ok: true, scanned: 1, truncated: true });
  expect(await run("local.fs_search", { path: join(root, "nested", "loop"), query: "match" })).toMatchObject({ ok: false });
  expect(await run("local.fs_list", { path: join(root, "nested"), limit: 1 })).toMatchObject({ ok: true, truncated: true });
});

test("directories require explicit recursive deletion and absolute paths are enforced", async () => {
  const path = join(root, "parent", "child");
  expect(await run("local.fs_mkdir", { path, recursive: true })).toMatchObject({ ok: true });
  expect(await run("local.fs_stat", { path })).toMatchObject({ ok: true, type: "directory" });
  expect(await run("local.fs_delete", { path: join(root, "parent") })).toMatchObject({ ok: false });
  expect(await run("local.fs_delete", { path: join(root, "parent"), recursive: true })).toMatchObject({ ok: true });
  expect(await run("local.fs_write", { path: "relative", content: "x" })).toMatchObject({ ok: false });
  expect(await run("local.fs_delete", { path: "/", recursive: true })).toMatchObject({ ok: false });
});
