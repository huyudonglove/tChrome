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
    const result = await run("local.fs_read", { items: [{ path, offset, limit: 4 }] });
    expect(result.ok).toBe(true);
    const row = (result.results as Record<string, unknown>[])[0]!;
    content += row.content as string;
    offset = row.nextOffset as number;
    if (!row.truncated) break;
  }
  expect(content).toBe("abc你好世界!");
  expect(offset).toBe(16);
  expect(await run("local.fs_read", { items: [{ path: root }] })).toMatchObject({ ok: false, results: [{ ok: false }] });
  expect(await run("local.fs_read", { items: [{ path, offset: 100 }] })).toMatchObject({ ok: true, results: [{ content: "", truncated: false }] });
});

test("fs_read items read several files in one call with per-item ok", async () => {
  const a = join(root, "a.txt");
  const b = join(root, "b.txt");
  const missing = join(root, "missing.txt");
  await writeFile(a, "AAA");
  await writeFile(b, "BBB");
  const result = await run("local.fs_read", { items: [{ path: a }, { path: b }, { path: missing }] }) as { ok: boolean; results: { ok: boolean; content?: string; faultCode?: string }[] };
  expect(result.ok).toBe(false);
  expect(result.results.map((row) => row.content)).toEqual(["AAA", "BBB", undefined]);
  expect(result.results[0]!.ok).toBe(true);
  expect(result.results[2]).toMatchObject({ ok: false });
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
  const result = await run("local.fs_search", { items: [{ path: root, query: "match" }] });
  expect(result.ok).toBe(true);
  const row = (result.results as Record<string, unknown>[])[0]!;
  expect(row).toMatchObject({ ok: true, scanned: 3, truncated: false, matches: [{ name: "match.txt", path: join(root, "nested", "match.txt"), type: "file" }] });
  const capped = await run("local.fs_search", { items: [{ path: root, query: "match", maxEntries: 1 }] });
  expect((capped.results as Record<string, unknown>[])[0]).toMatchObject({ ok: true, scanned: 1, truncated: true });
  const bad = await run("local.fs_search", { items: [{ path: join(root, "nested", "loop"), query: "match" }] });
  expect(bad.ok).toBe(false);
  expect((bad.results as Record<string, unknown>[])[0]).toMatchObject({ ok: false });
  expect(await run("local.fs_list", { path: join(root, "nested"), limit: 1 })).toMatchObject({ ok: true, truncated: true });
});

test("fs_search items batch several roots with per-item ok", async () => {
  const dirA = join(root, "a");
  const dirB = join(root, "b");
  await mkdir(dirA);
  await mkdir(dirB);
  await writeFile(join(dirA, "alpha.txt"), "a");
  await writeFile(join(dirB, "beta.txt"), "b");
  const result = await run("local.fs_search", {
    items: [
      { path: dirA, query: "alpha" },
      { path: dirB, query: "beta" },
      { path: join(root, "missing-dir"), query: "x" },
    ],
  }) as { ok: boolean; results: { ok: boolean; matches?: { name: string }[]; faultCode?: string }[] };
  expect(result.ok).toBe(false);
  expect(result.results[0]).toMatchObject({ ok: true });
  expect(result.results[0]!.matches?.[0]?.name).toBe("alpha.txt");
  expect(result.results[1]).toMatchObject({ ok: true });
  expect(result.results[1]!.matches?.[0]?.name).toBe("beta.txt");
  expect(result.results[2]).toMatchObject({ ok: false });
  expect(await run("local.fs_search", { items: [] })).toMatchObject({ ok: false });
  expect(await run("local.fs_search", { path: root, query: "match" })).toMatchObject({ ok: false });
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

test("local.replace_block replaces unique block and rejects mismatched matches", async () => {
  const path = join(root, "replace_target.txt");
  await writeFile(path, "const a = 1;\nconst b = 2;\nconst c = 1;\n", "utf8");

  // 1. 唯一匹配替换成功
  const r1 = await run("local.replace_block", {
    path,
    search: "const b = 2;",
    replace: "const b = 20;",
  });
  expect(r1).toMatchObject({ ok: true, matches: 1 });
  expect(await readFile(path, "utf8")).toBe("const a = 1;\nconst b = 20;\nconst c = 1;\n");

  // 2. 匹配次数不符合预期时报错，原文件保持不变
  const r2 = await run("local.replace_block", {
    path,
    search: "const a = 1;",
    replace: "const a = 10;",
    expectedMatches: 2, // 实际只有 1 个
  });
  expect(r2.ok).toBe(false);
  expect(String(r2.error)).toContain("Expected 2 match(es)");
  expect(await readFile(path, "utf8")).toBe("const a = 1;\nconst b = 20;\nconst c = 1;\n");

  // 3. 搜索内容未找到时报错
  const r3 = await run("local.replace_block", {
    path,
    search: "const not_exist = 0;",
    replace: "const not_exist = 1;",
  });
  expect(r3.ok).toBe(false);
  expect(String(r3.error)).toContain("Expected 1 match(es) for search block, but found 0");

  // 4. 多次匹配显式指定 expectedMatches
  const r4 = await run("local.replace_block", {
    path,
    search: "= 1;",
    replace: "= 100;",
    expectedMatches: 2,
  });
  expect(r4).toMatchObject({ ok: true, matches: 2 });
  expect(await readFile(path, "utf8")).toBe("const a = 100;\nconst b = 20;\nconst c = 100;\n");
});

test("grep finds literal text with line context and skips binaries, noisy dirs, and symlinks", async () => {
  const nested = join(root, "nested");
  const file = join(nested, "notes.txt");
  await mkdir(nested);
  await writeFile(file, "alpha needle beta\nsecond needle\n");
  await writeFile(join(nested, "skip.bin"), Buffer.from([0x00, ...Buffer.from("needle")]));
  await mkdir(join(nested, "node_modules"));
  await writeFile(join(nested, "node_modules", "hidden.txt"), "needle\n");
  await mkdir(join(nested, ".git"));
  await writeFile(join(nested, ".git", "hidden.txt"), "needle\n");
  await writeFile(join(nested, "wide.txt"), "needle-and-more-text");
  await symlink(file, join(nested, "link.txt"));
  await symlink(root, join(nested, "loop"));
  const result = await run("local.fs_grep", { path: root, query: "needle", contextChars: 6 });
  expect(result).toMatchObject({ ok: true, truncated: false });
  const matches = [...(result.matches as { path: string; line: number }[])].sort((a, b) =>
    a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1);
  expect(matches).toEqual([
    { path: file, line: 1, column: 7, before: "alpha ", hit: "needle", after: " beta" },
    { path: file, line: 2, column: 8, before: "econd ", hit: "needle", after: "" },
    { path: join(nested, "wide.txt"), line: 1, column: 1, before: "", hit: "needle", after: "-and-m" },
  ]);
  expect(JSON.stringify(result.matches)).not.toContain("hidden.txt");
  expect(JSON.stringify(result.matches)).not.toContain("link.txt");
  expect(result.skipped).toEqual(expect.arrayContaining([
    { path: join(nested, "skip.bin"), reason: "binary" },
    { path: join(nested, "node_modules"), reason: "skipped directory" },
    { path: join(nested, ".git"), reason: "skipped directory" },
  ]));
  const limited = await run("local.fs_grep", { path: root, query: "needle", limit: 1 });
  expect(limited).toMatchObject({ ok: true, truncated: true, partial: true });
  expect(limited.matches).toHaveLength(1);
  expect(limited.truncations).toContain("limit");

  const capped = await run("local.fs_grep", { path: root, query: "absent-token", maxFiles: 1 });
  expect(capped).toMatchObject({ ok: true, truncated: true, partial: true, matches: [] });
  expect(capped.truncations).toContain("maxFiles");
  expect(capped.scannedFiles).toBe(1);

  const entryCapped = await run("local.fs_grep", { path: root, query: "absent-token", maxEntries: 1 });
  expect(entryCapped).toMatchObject({ ok: true, truncated: true, partial: true, matches: [] });
  expect(entryCapped.truncations).toContain("maxEntries");

  const none = await run("local.fs_grep", { path: root, query: "absent-token" });
  expect(none).toMatchObject({ ok: true, truncated: false, partial: false, matches: [] });
  expect(none.skipped).toBeUndefined();
  expect(none.skippedCount).toBeGreaterThan(0);
  expect(none.note).toContain("no matches");

  const noneCapped = await run("local.fs_grep", { path: root, query: "absent-token", maxFiles: 1 });
  expect(noneCapped).toMatchObject({ ok: true, truncated: true, partial: true, matches: [] });
  expect(noneCapped.skipped).toBeUndefined();
  expect(String(noneCapped.note)).toContain("maxFiles");

  expect(await run("local.fs_grep", { path: root, query: "needle", maxFileBytes: 4 })).toMatchObject({
    ok: true, matches: [],
  });
  expect(await run("local.fs_grep", { path: join(nested, "loop"), query: "needle" })).toMatchObject({ ok: false });
});

test("grep supports regex mode and multi-line context extraction", async () => {
  const dir = join(root, "grepx");
  await mkdir(dir);
  const file = join(dir, "code.txt");
  await writeFile(file, ["L10 start", "L11 end_token = 1", "L12 middle", "L13 end_token = 2", "L14 tail"].join("\n"));

  const regex = await run("local.fs_grep", { path: dir, query: "end_\\w+", regex: true, contextLines: 2 });
  expect(regex).toMatchObject({ ok: true, truncated: false });
  expect(regex.matches).toEqual([
    {
      path: file, line: 2, column: 5, before: "L11 ", hit: "end_token", after: " = 1",
      beforeLines: ["L10 start"], afterLines: ["L12 middle", "L13 end_token = 2"],
    },
    {
      path: file, line: 4, column: 5, before: "L13 ", hit: "end_token", after: " = 2",
      beforeLines: ["L11 end_token = 1", "L12 middle"], afterLines: ["L14 tail"],
    },
  ]);

  const invalid = await run("local.fs_grep", { path: dir, query: "(", regex: true });
  expect(invalid).toMatchObject({ ok: false });
  expect(String(invalid.error)).toContain("Invalid regular expression");

  const literal = await run("local.fs_grep", { path: dir, query: "end_\\w+", contextLines: 0 });
  expect(literal).toMatchObject({ ok: true, matches: [] });
  expect((literal.matches as unknown[]).length).toBe(0);
});

test("fs_read supports line slice mode with startLine and endLine", async () => {
  const file = join(root, "lines.txt");
  const sample = ["line 1: apple", "line 2: banana", "line 3: cherry", "line 4: date", "line 5: elderberry"].join("\n");
  await writeFile(file, sample);

  // 1. Basic slice: lines 2 to 4
  const res1 = await run("local.fs_read", {
    items: [{ path: file, startLine: 2, endLine: 4 }],
  }) as { ok: boolean; results: Record<string, unknown>[] };
  expect(res1.ok).toBe(true);
  expect(res1.results[0]).toMatchObject({
    ok: true,
    path: file,
    content: "line 2: banana\nline 3: cherry\nline 4: date",
    startLine: 2,
    endLine: 4,
    totalLines: 5,
  });

  // 2. startLine only (reads to end of file)
  const res2 = await run("local.fs_read", {
    items: [{ path: file, startLine: 4 }],
  }) as { ok: boolean; results: Record<string, unknown>[] };
  expect(res2.ok).toBe(true);
  expect(res2.results[0]).toMatchObject({
    ok: true,
    content: "line 4: date\nline 5: elderberry",
    startLine: 4,
    endLine: 5,
    totalLines: 5,
  });

  // 3. Out of bounds startLine beyond totalLines
  const res3 = await run("local.fs_read", {
    items: [{ path: file, startLine: 10 }],
  }) as { ok: boolean; results: Record<string, unknown>[] };
  expect(res3.ok).toBe(true);
  expect(res3.results[0]).toMatchObject({
    ok: true,
    content: "",
    startLine: 10,
    totalLines: 5,
  });

  // 4. Reject mutually exclusive startLine and offset
  const res4 = await run("local.fs_read", {
    items: [{ path: file, startLine: 1, offset: 10 }],
  }) as { ok: boolean; results: Record<string, unknown>[] };
  expect(res4.ok).toBe(false);
  expect(res4.results[0]!.ok).toBe(false);

  // 5. Reject invalid endLine < startLine
  const res5 = await run("local.fs_read", {
    items: [{ path: file, startLine: 3, endLine: 2 }],
  }) as { ok: boolean; results: Record<string, unknown>[] };
  expect(res5.ok).toBe(false);
  expect(res5.results[0]!.ok).toBe(false);
});

test("directory tools explain a file path instead of leaking ENOTDIR", async () => {
  const file = join(root, "plain.txt");
  await writeFile(file, "x");
  for (const name of ["local.fs_list", "local.fs_search"] as const) {
    const input = name === "local.fs_search"
      ? { items: [{ path: file, query: "x" }] }
      : { path: file };
    const result = await run(name, input) as {
      ok: boolean; message?: string; error?: string;
      items?: { error?: string }[]; results?: { error?: string }[];
    };
    expect(result.ok).toBe(false);
    const detail = result.error ?? result.message ?? result.results?.[0]?.error ?? result.items?.[0]?.error ?? "";
    expect(detail).toContain("must be a directory");
    expect(detail).toContain("local.fs_stat");
    expect(detail).not.toContain("ENOTDIR");
  }
});

test("fs_grep accepts a single file path and searches only that file", async () => {
  const nested = join(root, "nested");
  await mkdir(nested);
  const target = join(nested, "target.ts");
  await writeFile(target, "const alpha = 1;\nconst beta = 2;\n");
  await writeFile(join(nested, "sibling.ts"), "const alpha = 3;\n");
  await mkdir(join(nested, "deep"));
  await writeFile(join(nested, "deep", "deeper.ts"), "const alpha = 4;\n");

  const result = await run("local.fs_grep", { path: target, query: "alpha", contextChars: 10 }) as {
    ok: boolean;
    path: string;
    matches: { path: string; line: number; column: number }[];
    scannedFiles: number;
  };
  expect(result.ok).toBe(true);
  expect(result.path).toBe(target);
  expect(result.matches.map((row) => row.path)).toEqual([target]);
  expect(result.matches[0]).toMatchObject({ path: target, line: 1, column: 7 });
  expect(result.scannedFiles).toBe(1);

  const regex = await run("local.fs_grep", { path: target, query: "const (alpha|beta)", regex: true }) as {
    ok: boolean;
    matches: { line: number }[];
  };
  expect(regex.ok).toBe(true);
  expect(regex.matches.map((row) => row.line)).toEqual([1, 2]);

  const missing = await run("local.fs_grep", { path: join(nested, "nope.ts"), query: "alpha" });
  expect(missing.ok).toBe(false);
});
