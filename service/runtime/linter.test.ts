import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lintSourceCode, lintPath } from "./linter.ts";

describe("linter: 毫秒级代码静态诊断与规则引擎", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "linter-test-"));
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("1. lintSourceCode: 干净代码诊断通过，无错误无警告", () => {
    const cleanCode = `
export function add(a: number, b: number): number {
  return a + b;
}
`;
    const res = lintSourceCode(cleanCode, "src/clean.ts");
    expect(res.ok).toBe(true);
    expect(res.errorsCount).toBe(0);
    expect(res.warningsCount).toBe(0);
    expect(res.diagnostics.length).toBe(0);
  });

  test("2. lintSourceCode: 毫秒级精准捕获语法级致命错误（Syntax Error）", () => {
    // 包含未闭合括号/非法操作符的语法断裂
    const brokenCode = `
export function broken() {
  const x = ;
}
`;
    const res = lintSourceCode(brokenCode, "src/broken.ts");
    expect(res.ok).toBe(false);
    expect(res.errorsCount).toBeGreaterThanOrEqual(1);

    const syntaxDiag = res.diagnostics.find((d) => d.rule === "syntax-error");
    expect(syntaxDiag).toBeDefined();
    expect(syntaxDiag?.severity).toBe("error");
    expect(syntaxDiag?.line).toBeGreaterThanOrEqual(1);
  });

  test("3. lintSourceCode: 检测代码坏味道规则（no-debugger, no-var, no-empty-catch）", () => {
    const smellyCode = `
var oldStyle = 123;

function debugMe() {
  debugger;
}

try {
  doSomething();
} catch (err) {}
`;
    const res = lintSourceCode(smellyCode, "src/smelly.ts");
    expect(res.ok).toBe(true); // 警告不阻止 ok
    expect(res.warningsCount).toBe(3);

    const rules = res.diagnostics.map((d) => d.rule);
    expect(rules).toContain("no-var");
    expect(rules).toContain("no-debugger");
    expect(rules).toContain("no-empty-catch");
  });

  test("4. lintPath: 目录递归扫描与格式化诊断报告生成", () => {
    mkdirSync(join(testDir, "src"), { recursive: true });

    // 文件 1：良好
    writeFileSync(join(testDir, "src", "good.ts"), "export const ok = true;");

    // 文件 2：有 warning
    writeFileSync(join(testDir, "src", "warn.ts"), "var legacy = 'bad';");

    // 文件 3：有 error
    writeFileSync(join(testDir, "src", "err.ts"), "const bad = {;");

    const summary = lintPath(testDir);

    expect(summary.totalFiles).toBe(3);
    expect(summary.passedFiles).toBe(2);
    expect(summary.failedFiles).toBe(1);
    expect(summary.totalErrors).toBeGreaterThanOrEqual(1);
    expect(summary.totalWarnings).toBeGreaterThanOrEqual(1);

    expect(summary.formattedReport).toContain("Fast Linter Diagnostics Report");
    expect(summary.formattedReport).toContain("err.ts");
    expect(summary.formattedReport).toContain("[ERROR]");
    expect(summary.formattedReport).toContain("warn.ts");
    expect(summary.formattedReport).toContain("[WARNING]");
  });
});
