import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  createCheckpoint,
  getDiffSummary,
  getStatusFiles,
  isGitClean,
  rollback,
} from "./git-guard.ts";

describe("git-guard: Git 事务化检查点与安全回滚护栏", () => {
  let testRepoDir: string;

  beforeEach(() => {
    // 建立完全隔离的临时 Git 测试仓库，绝不污染真实项目 Git 工作区
    testRepoDir = mkdtempSync(join(tmpdir(), "git-guard-test-"));
    execSync("git init -b main", { cwd: testRepoDir });
    execSync('git config user.email "agent@tchrome.local"', { cwd: testRepoDir });
    execSync('git config user.name "tChrome Agent"', { cwd: testRepoDir });

    // 初始基线提交
    writeFileSync(join(testRepoDir, "README.md"), "# Initial Commit\n");
    execSync("git add README.md", { cwd: testRepoDir });
    execSync('git commit -m "chore: initial commit"', { cwd: testRepoDir });
  });

  afterEach(() => {
    try {
      rmSync(testRepoDir, { recursive: true, force: true });
    } catch {
      // 容错忽略
    }
  });

  test("1. isGitClean: 初始干净工作区能够准确识别", async () => {
    const clean = await isGitClean(testRepoDir);
    expect(clean).toBe(true);

    const files = await getStatusFiles(testRepoDir);
    expect(files.length).toBe(0);
  });

  test("2. createCheckpoint: 干净状态下创建检查点，记录完整 HEAD 与分支", async () => {
    const checkpoint = await createCheckpoint(testRepoDir, "clean-baseline");

    expect(checkpoint.label).toBe("clean-baseline");
    expect(checkpoint.isClean).toBe(true);
    expect(checkpoint.branch).toBe("main");
    expect(checkpoint.head.length).toBe(40);
    expect(checkpoint.dirtyFiles.length).toBe(0);
    expect(checkpoint.stashCommit).toBeUndefined();
  });

  test("3. getDiffSummary: 能精准感知已修改文件、新增未跟踪文件与增删统计", async () => {
    // 触发修改与新增
    writeFileSync(join(testRepoDir, "README.md"), "# Modified Commit\nLine 2\n");
    writeFileSync(join(testRepoDir, "new_file.txt"), "hello world\n");

    const clean = await isGitClean(testRepoDir);
    expect(clean).toBe(false);

    const statusFiles = await getStatusFiles(testRepoDir);
    expect(statusFiles.length).toBe(2);

    const paths = statusFiles.map((f) => f.path);
    expect(paths).toContain("README.md");
    expect(paths).toContain("new_file.txt");

    const diff = await getDiffSummary(testRepoDir);
    expect(diff.filesChanged).toBeGreaterThanOrEqual(1);
    expect(diff.files.length).toBe(2);
  });

  test("4. rollback: 当代码修改失败时，一键原子回滚消除所有改动与临时文件", async () => {
    // 1. 基线检查点
    const baseline = await createCheckpoint(testRepoDir, "pre-mutation");

    // 2. 模拟破坏性修改：修改已有文件 + 新建临时垃圾文件
    writeFileSync(join(testRepoDir, "README.md"), "# Broken Code\nThis causes crash!\n");
    writeFileSync(join(testRepoDir, "garbage.tmp"), "trash content\n");

    expect(await isGitClean(testRepoDir)).toBe(false);
    expect(existsSync(join(testRepoDir, "garbage.tmp"))).toBe(true);

    // 3. 执行原子回滚
    const result = await rollback(testRepoDir, baseline, { cleanUntracked: true });
    expect(result.ok).toBe(true);
    expect(result.restoredToHead).toBe(baseline.head);

    // 4. 断言工作区完全复原
    const cleanAfter = await isGitClean(testRepoDir);
    expect(cleanAfter).toBe(true);

    // 未跟踪文件被彻底清除
    expect(existsSync(join(testRepoDir, "garbage.tmp"))).toBe(false);
  });

  test("5. createCheckpoint & rollback on dirty workspace: 支持在工作区已有临时修改时建检查点并恢复现场", async () => {
    // 用户已有未提交修改
    writeFileSync(join(testRepoDir, "user_wip.txt"), "user working progress\n");
    execSync("git add user_wip.txt", { cwd: testRepoDir });

    // 创建检查点（捕获了 stashCommit）
    const checkpoint = await createCheckpoint(testRepoDir, "dirty-start");
    expect(checkpoint.isClean).toBe(false);
    expect(checkpoint.stashCommit).toBeDefined();

    // Agent 后续操作追加了破坏性修改
    writeFileSync(join(testRepoDir, "README.md"), "# Agent broken edit\n");
    writeFileSync(join(testRepoDir, "agent_bad.js"), "throw new Error();\n");

    // 执行回滚
    const result = await rollback(testRepoDir, checkpoint, { cleanUntracked: true });
    expect(result.ok).toBe(true);

    // 用户的 wip 文件完好无损地被保留恢复
    expect(existsSync(join(testRepoDir, "user_wip.txt"))).toBe(true);
    // Agent 临时制造的坏文件被清理
    expect(existsSync(join(testRepoDir, "agent_bad.js"))).toBe(false);
  });
});
