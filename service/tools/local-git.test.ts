import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runLocalGitTool, LOCAL_GIT_TOOL_NAMES } from "./local-git.ts";

test("LOCAL_GIT_TOOL_NAMES contains expected tools", () => {
  expect(LOCAL_GIT_TOOL_NAMES).toContain("local_git_status");
  expect(LOCAL_GIT_TOOL_NAMES).toContain("local_git_diff");
});

test("local_git_status and local_git_diff work on clean and modified repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-git-test-"));
  try {
    // init git repo
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "TestUser"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });

    // Initial status on empty repo
    const initialStatus = await runLocalGitTool("local_git_status", {
      path: dir,
      reason: "check initial status",
    });
    expect(initialStatus).toMatchObject({
      ok: true,
      clean: true,
      branch: "main",
      staged: [],
      unstaged: [],
      untracked: [],
    });

    // Create a file and commit it
    const readme = join(dir, "README.md");
    writeFileSync(readme, "# Hello Git\nline 1\nline 2\n", "utf8");

    // Status shows untracked
    const untrackedStatus = await runLocalGitTool("local_git_status", {
      path: dir,
      reason: "check untracked status",
    });
    expect(untrackedStatus).toMatchObject({
      ok: true,
      clean: false,
      untracked: ["README.md"],
    });

    execFileSync("git", ["add", "README.md"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "init commit"], { cwd: dir });

    // After commit, should be clean
    const committedStatus = await runLocalGitTool("local_git_status", {
      path: dir,
      reason: "check committed status",
    });
    expect(committedStatus).toMatchObject({
      ok: true,
      clean: true,
    });

    // Modify file
    writeFileSync(readme, "# Hello Git\nline 1 modified\nline 2\nline 3\n", "utf8");

    // Status shows unstaged
    const modifiedStatus = await runLocalGitTool("local_git_status", {
      path: dir,
      reason: "check modified status",
    });
    expect(modifiedStatus).toMatchObject({
      ok: true,
      clean: false,
      unstaged: [{ status: "M", path: "README.md" }],
    });

    // Diff unstaged
    const unstagedDiff = await runLocalGitTool("local_git_diff", {
      path: dir,
      reason: "check diff unstaged",
    });
    expect(unstagedDiff).toMatchObject({
      ok: true,
      truncated: false,
    });
    expect((unstagedDiff as any).files).toContain("README.md");
    expect((unstagedDiff as any).diff).toContain("+line 1 modified");

    // Stage changes
    execFileSync("git", ["add", "README.md"], { cwd: dir });

    // Diff cached
    const cachedDiff = await runLocalGitTool("local_git_diff", {
      path: dir,
      cached: true,
      reason: "check diff cached",
    });
    expect(cachedDiff).toMatchObject({
      ok: true,
    });
    expect((cachedDiff as any).files).toContain("README.md");
    expect((cachedDiff as any).diff).toContain("+line 1 modified");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local_apply_patch applies multiple files from a repository subdirectory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-patch-test-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "existing file.txt"), "before\nkeep\n");
    writeFileSync(join(dir, "deleted.txt"), "remove\n");
    const result = await runLocalGitTool("local_apply_patch", {
      path: join(dir, "nested"),
      patch: [
        "diff --git a/existing file.txt b/existing file.txt",
        "--- a/existing file.txt",
        "+++ b/existing file.txt",
        "@@ -1,99 +1,99 @@",
        "-before",
        "+after",
        " keep",
        "diff --git a/added.txt b/added.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/added.txt",
        "@@ -0,0 +1 @@",
        "+new",
        "diff --git a/deleted.txt b/deleted.txt",
        "deleted file mode 100644",
        "--- a/deleted.txt",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-remove",
        "",
      ].join("\n"),
      reason: "test multi-file patch",
    });
    expect(result).toEqual({
      ok: true,
      path: realpathSync(dir),
      files: ["existing file.txt", "added.txt", "deleted.txt"],
    });
    expect(readFileSync(join(dir, "existing file.txt"), "utf8")).toBe("after\nkeep\n");
    expect(readFileSync(join(dir, "added.txt"), "utf8")).toBe("new\n");
    expect(existsSync(join(dir, "deleted.txt"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local_apply_patch leaves all files unchanged when one hunk fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-patch-test-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    writeFileSync(join(dir, "first.txt"), "first\n");
    writeFileSync(join(dir, "second.txt"), "second\n");
    const result = await runLocalGitTool("local_apply_patch", {
      path: dir,
      patch: [
        "diff --git a/first.txt b/first.txt",
        "--- a/first.txt",
        "+++ b/first.txt",
        "@@ -1 +1 @@",
        "-first",
        "+changed",
        "diff --git a/second.txt b/second.txt",
        "--- a/second.txt",
        "+++ b/second.txt",
        "@@ -1 +1 @@",
        "-wrong context",
        "+changed",
        "",
      ].join("\n"),
      reason: "test failed patch",
    });
    expect(result).toMatchObject({ ok: false, faultCode: "local_git_failed" });
    expect(readFileSync(join(dir, "first.txt"), "utf8")).toBe("first\n");
    expect(readFileSync(join(dir, "second.txt"), "utf8")).toBe("second\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local_apply_patch rejects malformed patches without changing files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-patch-test-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    writeFileSync(join(dir, "file.txt"), "original\n");
    for (const patch of ["", "not a diff\n"]) {
      const result = await runLocalGitTool("local_apply_patch", {
        path: dir,
        patch,
        reason: "test invalid patch",
      });
      expect(result).toMatchObject({ ok: false, faultCode: "local_git_failed" });
      expect(readFileSync(join(dir, "file.txt"), "utf8")).toBe("original\n");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
