import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitCheckpoint {
  id: string;
  createdAt: string;
  label: string;
  head: string;
  branch: string;
  isClean: boolean;
  dirtyFiles: string[];
  stashCommit?: string;
}

export interface DiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: Array<{
    path: string;
    status: "modified" | "added" | "deleted" | "untracked";
    insertions?: number;
    deletions?: number;
  }>;
  rawStat: string;
}

export interface RollbackOptions {
  cleanUntracked?: boolean;
}

export interface RollbackResult {
  ok: boolean;
  restoredToHead: string;
  restoredStash?: string;
  error?: string;
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

/**
 * 检查 Git 工作区状态是否干净
 */
export async function isGitClean(repoRoot: string): Promise<boolean> {
  const status = await runGit(["status", "--porcelain"], repoRoot);
  return status.length === 0;
}

/**
 * 获取当前工作区修改过的文件清单（含未跟踪文件）
 */
export async function getStatusFiles(repoRoot: string): Promise<Array<{ path: string; status: "modified" | "added" | "deleted" | "untracked" }>> {
  const statusOutput = await runGit(["status", "--porcelain"], repoRoot);
  if (!statusOutput) return [];

  const lines = statusOutput.split("\n").filter(Boolean);
  return lines.map((line) => {
    // git status --porcelain 格式为 XY PATH 或 "?? PATH"
    const code = line.slice(0, 2);
    const path = line.slice(2).trim();
    if (code.includes("?")) {
      return { path, status: "untracked" };
    }
    if (code.includes("D")) {
      return { path, status: "deleted" };
    }
    if (code.includes("A")) {
      return { path, status: "added" };
    }
    return { path, status: "modified" };
  });
}

/**
 * 创建轻量安全检查点（无侵入：利用 git stash create 保存暂存态，不破坏当前工作区）
 */
export async function createCheckpoint(repoRoot: string, label = "auto-checkpoint"): Promise<GitCheckpoint> {
  const head = await runGit(["rev-parse", "HEAD"], repoRoot);
  let branch = "HEAD";
  try {
    branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  } catch {
    // detached head 保持 HEAD
  }

  const dirtyFilesInfo = await getStatusFiles(repoRoot);
  const isClean = dirtyFilesInfo.length === 0;
  const dirtyFiles = dirtyFilesInfo.map((f) => f.path);

  let stashCommit: string | undefined;
  if (!isClean) {
    // git stash create 创建 commit 对象并返回 SHA，但不把改动压栈，也不修改 working tree
    const created = await runGit(["stash", "create", `git-guard: ${label}`], repoRoot);
    if (created && created.length >= 40) {
      stashCommit = created;
    }
  }

  const checkpoint: GitCheckpoint = {
    id: `chk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    label,
    head,
    branch,
    isClean,
    dirtyFiles,
    stashCommit,
  };

  return checkpoint;
}

/**
 * 获取当前改动或相对指定检查点的 Diff 概览与行数统计
 */
export async function getDiffSummary(repoRoot: string, baseHead?: string): Promise<DiffStat> {
  const statusFiles = await getStatusFiles(repoRoot);
  const gitArgs = baseHead ? ["diff", "--stat", baseHead] : ["diff", "--stat", "HEAD"];

  let rawStat = "";
  try {
    rawStat = await runGit(gitArgs, repoRoot);
  } catch {
    rawStat = "";
  }

  let filesChanged = statusFiles.length;
  let insertions = 0;
  let deletions = 0;

  if (rawStat) {
    const match = rawStat.match(/(\d+)\s+files? changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/);
    if (match) {
      filesChanged = parseInt(match[1] || "0", 10);
      insertions = parseInt(match[2] || "0", 10);
      deletions = parseInt(match[3] || "0", 10);
    }
  }

  return {
    filesChanged,
    insertions,
    deletions,
    files: statusFiles,
    rawStat,
  };
}

/**
 * 一键安全回滚到指定检查点状态（原子化清理与恢复）
 */
export async function rollback(
  repoRoot: string,
  checkpoint: GitCheckpoint,
  options: RollbackOptions = { cleanUntracked: true }
): Promise<RollbackResult> {
  try {
    // 1. 恢复工作区已跟踪文件至 HEAD 或 checkpoint.head
    await runGit(["reset", "--hard", checkpoint.head], repoRoot);

    // 2. 清理新引入的未跟踪文件与目录
    if (options.cleanUntracked) {
      await runGit(["clean", "-fd"], repoRoot);
    }

    // 3. 如果检查点创建时工作区是脏的，并且记录了 stashCommit，恢复当时的工作现场
    if (checkpoint.stashCommit) {
      await runGit(["stash", "apply", "--index", checkpoint.stashCommit], repoRoot);
    }

    return {
      ok: true,
      restoredToHead: checkpoint.head,
      restoredStash: checkpoint.stashCommit,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      restoredToHead: checkpoint.head,
      error: errorMsg,
    };
  }
}
