#!/usr/bin/env bun
import { join } from "node:path";
import {
  createCheckpoint,
  getDiffSummary,
  isGitClean,
  rollback,
  type GitCheckpoint,
} from "../service/runtime/git-guard.ts";

const repoRoot = join(import.meta.dir, "..");
const command = process.argv[2] || "status";

switch (command) {
  case "status": {
    const clean = await isGitClean(repoRoot);
    const diff = await getDiffSummary(repoRoot);
    console.log(JSON.stringify({ ok: true, clean, diff }, null, 2));
    break;
  }
  case "checkpoint": {
    const label = process.argv[3] || "cli-manual-checkpoint";
    const checkpoint = await createCheckpoint(repoRoot, label);
    console.log(JSON.stringify({ ok: true, checkpoint }, null, 2));
    break;
  }
  case "rollback": {
    const jsonStr = process.argv[3];
    if (!jsonStr) {
      console.error(JSON.stringify({ ok: false, error: "Missing checkpoint JSON argument" }));
      process.exit(1);
    }
    const checkpoint: GitCheckpoint = JSON.parse(jsonStr);
    // 破坏性清理需要显式开关：默认只恢复已跟踪文件，不删未跟踪文件
    const cleanUntracked = process.argv.includes("--clean");
    const result = await rollback(repoRoot, checkpoint, { cleanUntracked });
    console.log(JSON.stringify(result, null, 2));
    break;
  }
  default: {
    console.log("Usage: bun run scripts/git_guard.ts [status|checkpoint <label>|rollback <checkpoint-json> [--clean]]");
  }
}
