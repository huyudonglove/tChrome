import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
import { errorInfo } from "../../shared/errors.ts";

const execFileAsync = promisify(execFile);

export const LOCAL_GIT_TOOL_NAMES = [
  "local.git_status",
  "local.git_diff",
] as const;

export type LocalGitToolName = (typeof LOCAL_GIT_TOOL_NAMES)[number];

function pathArg(input: Record<string, unknown>, key = "path"): string {
  const value = input[key];
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${key} must be an absolute path`);
  }
  return value;
}

export type GitStatusResult = {
  ok: true;
  branch: string;
  clean: boolean;
  staged: Array<{ status: string; path: string }>;
  unstaged: Array<{ status: string; path: string }>;
  untracked: string[];
  summary: string;
};

export async function runGitStatus(input: Record<string, unknown>): Promise<GitStatusResult> {
  const repoPath = pathArg(input, "path");

  const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-b"], {
    cwd: repoPath,
    maxBuffer: 4 * 1024 * 1024,
  });

  const lines = stdout.split("\n").filter((line) => line.length > 0);
  let branch = "HEAD";
  const staged: Array<{ status: string; path: string }> = [];
  const unstaged: Array<{ status: string; path: string }> = [];
  const untracked: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      let branchInfo = line.slice(3).trim();
      if (branchInfo.startsWith("No commits yet on ")) {
        branchInfo = branchInfo.slice("No commits yet on ".length).trim();
      } else if (branchInfo.startsWith("Initial commit on ")) {
        branchInfo = branchInfo.slice("Initial commit on ".length).trim();
      }
      branch = branchInfo.split("...")[0] ?? branchInfo;
      continue;
    }
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    const filePath = line.slice(3).trim();

    if (x === "?" && y === "?") {
      untracked.push(filePath);
      continue;
    }

    if (x !== " " && x !== "?") {
      staged.push({ status: x, path: filePath });
    }
    if (y !== " " && y !== "?") {
      unstaged.push({ status: y, path: filePath });
    }
  }

  const clean = staged.length === 0 && unstaged.length === 0 && untracked.length === 0;
  const summaryParts: string[] = [`branch: ${branch}`];
  if (clean) {
    summaryParts.push("clean");
  } else {
    if (staged.length > 0) summaryParts.push(`${staged.length} staged`);
    if (unstaged.length > 0) summaryParts.push(`${unstaged.length} unstaged`);
    if (untracked.length > 0) summaryParts.push(`${untracked.length} untracked`);
  }

  return {
    ok: true,
    branch,
    clean,
    staged,
    unstaged,
    untracked,
    summary: summaryParts.join(", "),
  };
}

export type GitDiffResult = {
  ok: true;
  diff: string;
  files: string[];
  truncated: boolean;
  totalLines: number;
};

export async function runGitDiff(input: Record<string, unknown>): Promise<GitDiffResult> {
  const repoPath = pathArg(input, "path");
  const cached = Boolean(input.cached);
  const commit = typeof input.commit === "string" ? input.commit.trim() : undefined;
  const file = typeof input.file === "string" ? input.file.trim() : undefined;
  const statOnly = Boolean(input.statOnly);
  const maxLines = typeof input.maxLines === "number" && input.maxLines > 0 ? Math.min(input.maxLines, 2000) : 500;

  const args: string[] = ["diff"];
  if (statOnly) {
    args.push("--stat");
  }
  if (cached) {
    args.push("--cached");
  }
  if (commit) {
    args.push(commit);
  }
  if (file) {
    args.push("--", file);
  }

  const { stdout } = await execFileAsync("git", args, {
    cwd: repoPath,
    maxBuffer: 8 * 1024 * 1024,
  });

  // Extract changed files list
  const fileNamesArgs = ["diff", "--name-only"];
  if (cached) fileNamesArgs.push("--cached");
  if (commit) fileNamesArgs.push(commit);
  if (file) fileNamesArgs.push("--", file);

  const { stdout: filesStdout } = await execFileAsync("git", fileNamesArgs, {
    cwd: repoPath,
    maxBuffer: 2 * 1024 * 1024,
  }).catch(() => ({ stdout: "" }));

  const files = filesStdout.split("\n").filter((f) => f.trim().length > 0);

  const allLines = stdout.split("\n");
  const totalLines = allLines.length;
  let diff = stdout;
  let truncated = false;

  if (totalLines > maxLines) {
    diff = allLines.slice(0, maxLines).join("\n") + `\n\n... (truncated: showing first ${maxLines} of ${totalLines} lines)`;
    truncated = true;
  }

  return {
    ok: true,
    diff,
    files,
    truncated,
    totalLines,
  };
}

export async function runLocalGitTool(name: string, input: Record<string, unknown>) {
  try {
    switch (name) {
      case "local.git_status":
        return await runGitStatus(input);
      case "local.git_diff":
        return await runGitDiff(input);
      default:
        throw new Error(`unknown local git tool ${name}`);
    }
  } catch (err) {
    const info = errorInfo(err, "local_git_failed");
    return { ok: false, faultCode: info.faultCode, message: info.detail, details: info.details };
  }
}
