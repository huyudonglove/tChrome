import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runLocalGitTool, LOCAL_GIT_TOOL_NAMES } from "./local-git.ts";

test("LOCAL_GIT_TOOL_NAMES contains expected tools", () => {
  expect(LOCAL_GIT_TOOL_NAMES).toContain("local.git_status");
  expect(LOCAL_GIT_TOOL_NAMES).toContain("local.git_diff");
});

test("local.git_status and local.git_diff work on clean and modified repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-git-test-"));
  try {
    // init git repo
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "TestUser"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });

    // Initial status on empty repo
    const initialStatus = await runLocalGitTool("local.git_status", {
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
    const untrackedStatus = await runLocalGitTool("local.git_status", {
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
    const committedStatus = await runLocalGitTool("local.git_status", {
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
    const modifiedStatus = await runLocalGitTool("local.git_status", {
      path: dir,
      reason: "check modified status",
    });
    expect(modifiedStatus).toMatchObject({
      ok: true,
      clean: false,
      unstaged: [{ status: "M", path: "README.md" }],
    });

    // Diff unstaged
    const unstagedDiff = await runLocalGitTool("local.git_diff", {
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
    const cachedDiff = await runLocalGitTool("local.git_diff", {
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
