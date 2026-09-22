import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, relative, extname } from "node:path";

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  file: string;
  line: number;
  col: number;
  severity: DiagnosticSeverity;
  rule: string;
  message: string;
  sourceLine?: string;
}

export interface LintResult {
  file: string;
  ok: boolean;
  errorsCount: number;
  warningsCount: number;
  diagnostics: Diagnostic[];
}

export interface LintSummary {
  totalFiles: number;
  passedFiles: number;
  failedFiles: number;
  totalErrors: number;
  totalWarnings: number;
  results: LintResult[];
  formattedReport: string;
}

export interface LintOptions {
  checkRules?: boolean;
  allowDebugger?: boolean;
  allowVar?: boolean;
  excludePatterns?: string[];
  maxErrors?: number;
}

const DEFAULT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const DEFAULT_EXCLUDES = new Set([
  "node_modules",
  "dist",
  ".git",
  "coverage",
  "process-output",
  "returns",
  "turns",
]);

/**
 * 获取对应文件后缀的 Transpiler loader
 */
function getLoader(ext: string): "ts" | "tsx" | "js" | "jsx" {
  switch (ext) {
    case ".tsx":
      return "tsx";
    case ".jsx":
      return "jsx";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "js";
    case ".ts":
    default:
      return "ts";
  }
}

/**
 * 诊断单个代码字符串的语法与静态规则
 */
export function lintSourceCode(
  code: string,
  filePath: string,
  options: LintOptions = {}
): LintResult {
  const diagnostics: Diagnostic[] = [];
  const ext = extname(filePath) || ".ts";
  const loader = getLoader(ext);

  const lines = code.split("\n");

  // 1. 语法级诊断（基于 Bun.Transpiler 毫秒级 AST 编译试探）
  try {
    const transpiler = new Bun.Transpiler({ loader });
    transpiler.transformSync(code);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    // 从 Bun.Transpiler 报错信息中提取行号与列号 (例如: "... at path:line:col" 或解析错误信息)
    let line = 1;
    let col = 1;

    const lineColMatch = errorMsg.match(/:(\d+):(\d+)/) || errorMsg.match(/line\s+(\d+)/i);
    if (lineColMatch) {
      line = parseInt(lineColMatch[1] || "1", 10);
      if (lineColMatch[2]) col = parseInt(lineColMatch[2], 10);
    }

    diagnostics.push({
      file: filePath,
      line,
      col,
      severity: "error",
      rule: "syntax-error",
      message: errorMsg,
      sourceLine: lines[line - 1] ? lines[line - 1].trim() : undefined,
    });
  }

  // 2. 静态规则诊断（Lint Rules）
  if (options.checkRules !== false) {
    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const rawLine = lines[i];
      const trimmed = rawLine.trim();

      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
        continue;
      }

      // 规则 A: 禁止遗留 debugger 语句 (精确匹配独立语句，避免误伤字符串字面量)
      if (!options.allowDebugger && /^\s*debugger\s*;?$/.test(trimmed)) {
        diagnostics.push({
          file: filePath,
          line: lineNum,
          col: rawLine.indexOf("debugger") + 1,
          severity: "warning",
          rule: "no-debugger",
          message: "Unexpected 'debugger' statement in code.",
          sourceLine: trimmed,
        });
      }

      // 规则 B: 警惕过时的 var 声明 (建议 const/let)
      if (!options.allowVar && /^\s*var\s+[A-Za-z0-9_$]+/.test(rawLine)) {
        diagnostics.push({
          file: filePath,
          line: lineNum,
          col: rawLine.indexOf("var") + 1,
          severity: "warning",
          rule: "no-var",
          message: "Use 'let' or 'const' instead of 'var'.",
          sourceLine: trimmed,
        });
      }

      // 规则 C: 警惕空 catch 块 (catch (e) {}) 容易吞掉致命报错
      if (/catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(trimmed)) {
        diagnostics.push({
          file: filePath,
          line: lineNum,
          col: rawLine.indexOf("catch") + 1,
          severity: "warning",
          rule: "no-empty-catch",
          message: "Empty catch block detected. Potential silent failure.",
          sourceLine: trimmed,
        });
      }
    }
  }

  const errorsCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningsCount = diagnostics.filter((d) => d.severity === "warning").length;

  return {
    file: filePath,
    ok: errorsCount === 0,
    errorsCount,
    warningsCount,
    diagnostics,
  };
}

/**
 * 扫描指定文件或目录并返回全局静态诊断摘要
 */
export function lintPath(targetPath: string, options: LintOptions = {}): LintSummary {
  const filePaths: string[] = [];
  const stat = statSync(targetPath);

  const excludes = new Set(options.excludePatterns || DEFAULT_EXCLUDES);

  function walk(currentDir: string) {
    let entries: string[] = [];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (excludes.has(entry) || entry.startsWith(".")) continue;
      const fullPath = join(currentDir, entry);
      let s;
      try {
        s = statSync(fullPath);
      } catch {
        continue;
      }

      if (s.isDirectory()) {
        walk(fullPath);
      } else if (s.isFile()) {
        const ext = extname(entry);
        if (DEFAULT_EXTENSIONS.has(ext)) {
          filePaths.push(fullPath);
        }
      }
    }
  }

  if (stat.isDirectory()) {
    walk(targetPath);
  } else if (stat.isFile()) {
    filePaths.push(targetPath);
  }

  const results: LintResult[] = [];
  let totalErrors = 0;
  let totalWarnings = 0;
  let passedFiles = 0;
  let failedFiles = 0;

  const reportLines: string[] = [];

  for (const file of filePaths) {
    let code = "";
    try {
      code = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const relPath = relative(process.cwd(), file) || file;
    const res = lintSourceCode(code, relPath, options);
    results.push(res);

    totalErrors += res.errorsCount;
    totalWarnings += res.warningsCount;

    if (res.ok) {
      passedFiles++;
    } else {
      failedFiles++;
    }

    if (res.diagnostics.length > 0) {
      reportLines.push(`\n${relPath}:`);
      for (const diag of res.diagnostics) {
        const tag = diag.severity.toUpperCase();
        reportLines.push(
          `  [${tag}] ${diag.line}:${diag.col} - ${diag.message} (${diag.rule})`
        );
        if (diag.sourceLine) {
          reportLines.push(`    > ${diag.sourceLine}`);
        }
      }
    }
  }

  const header = `=== Fast Linter Diagnostics Report ===\nScanned ${filePaths.length} files. Passed: ${passedFiles}, Failed: ${failedFiles}, Errors: ${totalErrors}, Warnings: ${totalWarnings}\n`;
  const formattedReport = header + (reportLines.length > 0 ? reportLines.join("\n") : "All files clean. No errors or warnings found.");

  return {
    totalFiles: filePaths.length,
    passedFiles,
    failedFiles,
    totalErrors,
    totalWarnings,
    results,
    formattedReport,
  };
}
