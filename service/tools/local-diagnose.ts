import { errorInfo } from "../../shared/errors.ts";
import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { stat } from "node:fs/promises";

export interface DiagnosticError {
  file?: string;
  line?: number;
  col?: number;
  code?: string;
  message: string;
}

export interface DiagnoseResult {
  ok: boolean;
  passed: boolean;
  summary: string;
  errors: DiagnosticError[];
  rawTail?: string;
  exitCode: number | null;
}

function parseTypecheckOutput(output: string): DiagnosticError[] {
  const errors: DiagnosticError[] = [];
  // Matches standard TypeScript compiler output:
  // path/to/file.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.
  // or path/to/file.ts:12:5 - error TS2322: ...
  const regex1 = /^([^(:\n]+?)(?:\((\d+),(\d+)\)|:(\d+):(\d+))\s*(?:-\s*)?error\s*(TS\d+)?:?\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex1.exec(output)) !== null) {
    const file = match[1]?.trim();
    const line = parseInt(match[2] || match[4] || "0", 10);
    const col = parseInt(match[3] || match[5] || "0", 10);
    const code = match[6]?.trim();
    const message = match[7]?.trim() || "";
    errors.push({
      ...(file ? { file } : {}),
      ...(line ? { line } : {}),
      ...(col ? { col } : {}),
      ...(code ? { code } : {}),
      message,
    });
  }
  return errors;
}

function parseTestOutput(output: string): DiagnosticError[] {
  const errors: DiagnosticError[] = [];
  // Bun test failure pattern:
  // (fail) test name [duration]
  // or at file.test.ts:12:5
  const lines = output.split("\n");
  let currentFile: string | undefined;
  let currentTest: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const failMatch = line.match(/(?:✗|\(fail\)|FAIL)\s+(.+?)(?:\s+\[.+\])?$/);
    if (failMatch) {
      currentTest = failMatch[1]?.trim();
    }
    const fileMatch = line.match(/\((.+?):(\d+):(\d+)\)/) || line.match(/at\s+(.+?):(\d+):(\d+)/);
    if (fileMatch) {
      currentFile = fileMatch[1]?.trim();
      const lineNum = parseInt(fileMatch[2] || "0", 10);
      const colNum = parseInt(fileMatch[3] || "0", 10);
      if (currentTest) {
        errors.push({
          ...(currentFile ? { file: currentFile } : {}),
          line: lineNum,
          col: colNum,
          message: `Failed: ${currentTest}`,
        });
        currentTest = undefined;
      }
    }
  }

  // Fallback: if no structured error parsed but exit code was non-zero, capture top error lines
  if (errors.length === 0) {
    const errorLines = lines
      .filter((l) => l.includes("error:") || l.includes("Expected:") || l.includes("Received:") || l.includes("fail"))
      .slice(0, 5);
    if (errorLines.length > 0) {
      errors.push({
        message: errorLines.join("\n").trim(),
      });
    }
  }

  return errors;
}

export async function runLocalDiagnose(input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  try {
    const cwdRaw = input.cwd;
    if (typeof cwdRaw !== "string" || !isAbsolute(cwdRaw)) {
      throw new Error("cwd must be an absolute path");
    }
    const cwd = resolve(cwdRaw);
    const cwdStat = await stat(cwd);
    if (!cwdStat.isDirectory()) {
      throw new Error("cwd must be an existing directory");
    }

    const kind = input.kind;
    if (kind !== "typecheck" && kind !== "test") {
      throw new Error("kind must be either 'typecheck' or 'test'");
    }

    const target = typeof input.target === "string" && input.target.trim() ? input.target.trim() : undefined;
    const timeoutMs = typeof input.timeoutMs === "number" && input.timeoutMs > 0 ? input.timeoutMs : 60000;

    let executable = "bun";
    let args: string[] = [];

    if (kind === "typecheck") {
      executable = "bun";
      args = ["x", "tsc", "--noEmit", "--pretty", "false"];
      if (target) {
        args.push("--project", target);
      }
    } else {
      executable = "bun";
      args = ["test"];
      if (target) {
        args.push(target);
      }
    }

    return await new Promise<Record<string, unknown>>((resolvePromise) => {
      let stdout = "";
      let stderr = "";
      let settled = false;

      const child = spawn(executable, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill("SIGKILL");
        } catch {}
        resolvePromise({
          ok: false,
          passed: false,
          summary: `Timed out after ${timeoutMs}ms`,
          errors: [{ message: `Process timed out after ${timeoutMs}ms` }],
          exitCode: null,
        });
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({
          ok: false,
          passed: false,
          summary: `Failed to spawn: ${err.message}`,
          errors: [{ message: err.message }],
          exitCode: null,
        });
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        const combinedOutput = (stdout + "\n" + stderr).trim();
        const passed = code === 0;

        let errors: DiagnosticError[] = [];
        if (!passed) {
          errors = kind === "typecheck" ? parseTypecheckOutput(combinedOutput) : parseTestOutput(combinedOutput);
          if (errors.length === 0 && combinedOutput) {
            errors.push({
              message: combinedOutput.slice(-500).trim(),
            });
          }
        }

        const summary = passed
          ? `${kind === "typecheck" ? "Typecheck" : "Tests"} passed successfully`
          : `${errors.length} diagnostic error(s) found`;

        const rawTail = !passed && combinedOutput.length > 0 ? combinedOutput.slice(-1500).trim() : undefined;

        resolvePromise({
          ok: true,
          passed,
          summary,
          errorCount: errors.length,
          errors,
          ...(rawTail ? { rawTail } : {}),
          exitCode: code,
          signal,
        });
      });
    });
  } catch (error) {
    return {
      ok: false,
      passed: false,
      ...errorInfo(error),
    };
  }
}
