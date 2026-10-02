#!/usr/bin/env bun
import { spawn } from "child_process";

// 接收透传的参数，如 bun run test:summary service/
const args = process.argv.slice(2);
const bunArgs = ["test", ...args];

const proc = spawn("bun", bunArgs, {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, FORCE_COLOR: "0" },
});

let stdout = "";
let stderr = "";

proc.stdout.on("data", (d) => (stdout += d.toString()));
proc.stderr.on("data", (d) => (stderr += d.toString()));

proc.on("close", (code) => {
  const fullText = (stdout + "\n" + stderr).replace(/\x1b\[[0-9;]*m/g, "");
  const lines = fullText.split("\n");

  // 1. 提取统计摘要
  let passCount = 0;
  let failCount = 0;
  let summaryLine = "";

  for (const line of lines) {
    const trimmed = line.trim();
    const passMatch = trimmed.match(/^(\d+)\s+pass$/);
    if (passMatch) passCount = parseInt(passMatch[1], 10);
    const failMatch = trimmed.match(/^(\d+)\s+fail$/);
    if (failMatch) failCount = parseInt(failMatch[1], 10);
    if (trimmed.startsWith("Ran ") && trimmed.includes("tests across")) {
      summaryLine = trimmed;
    }
  }

  // 2. 如果全绿
  if (code === 0 && failCount === 0) {
    console.log(`\x1b[32m✔ All tests passed!\x1b[0m ${passCount} pass, 0 fail. ${summaryLine}`);
    process.exit(0);
  }

  // 3. 如果有失败，结构化解析失败块
  console.log(`\n\x1b[31m✖ Test Failures Summary (${failCount} failed):\x1b[0m\n`);

  interface Failure {
    file: string;
    testName: string;
    error: string;
    details: string[];
  }

  const failures: Failure[] = [];
  let currentFile = "";
  let currentFailure: Partial<Failure> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 检测文件路径，形如 path/to/file.test.ts:
    if (/^[A-Za-z0-9_./-]+\.(?:test|spec)\.(?:ts|js|tsx|jsx):$/.test(line.trim())) {
      currentFile = line.trim().replace(/:$/, "");
      continue;
    }

    // 检测失败用例，形如 (fail) test name [0.12ms]
    const failTestMatch = line.match(/\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?$/);
    if (failTestMatch) {
      if (currentFailure && currentFailure.testName) {
        failures.push(currentFailure as Failure);
      }
      currentFailure = {
        file: currentFile,
        testName: failTestMatch[1].trim(),
        error: "",
        details: [],
      };
      continue;
    }

    // 捕获错误信息行
    if (currentFailure) {
      if (line.trim().startsWith("error:")) {
        currentFailure.error = line.trim();
      } else if (
        line.trim().startsWith("Expected:") ||
        line.trim().startsWith("Received:") ||
        line.trim().startsWith("at ")
      ) {
        currentFailure.details?.push(line.trim());
      }
    }
  }

  if (currentFailure && currentFailure.testName) {
    failures.push(currentFailure as Failure);
  }

  if (failures.length > 0) {
    failures.forEach((f, idx) => {
      console.log(`[${idx + 1}] File: \x1b[33m${f.file || "unknown"}\x1b[0m`);
      console.log(`    Test: \x1b[1m${f.testName}\x1b[0m`);
      if (f.error) console.log(`    Error: \x1b[31m${f.error}\x1b[0m`);
      if (f.details && f.details.length > 0) {
        f.details.forEach((d) => console.log(`      ${d}`));
      }
      console.log("");
    });
  } else {
    // 兜底输出关键非 pass 行（如语法错误、超时退出等）
    console.log("Raw failure output excerpt:\n");
    lines
      .filter((l) => !/^\s*\d+\s+(pass|fail|expect)/.test(l) && l.trim())
      .slice(0, 40)
      .forEach((l) => console.log("  " + l));
  }

  console.log(`\n\x1b[31mFailed:\x1b[0m ${failCount} fail, ${passCount} pass. ${summaryLine}\n`);
  process.exit(code || 1);
});
