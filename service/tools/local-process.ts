import { allocateRecordId } from "../runtime/ids.ts";
import { errorInfo } from "../../shared/errors.ts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, extname, join, resolve } from "node:path";
import { stat, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { appendFileSync, rmSync } from "node:fs";
import { readScript } from "../scripts/store.ts";
import { StringDecoder } from "node:string_decoder";

export const LOCAL_PROCESS_TOOL_NAMES = ["local.run", "local.process_start", "local.process_status", "local.process_write", "local.process_stop", "local.open", "local.capabilities"] as const;
type Status = "running" | "exited" | "error" | "timeout" | "stopped";
interface Entry {
  processId: string;
  scope: string;
  filename?: string;
  path?: string;
  args: string[];
  cwd: string;
  child: ChildProcessWithoutNullStreams;
  status: Status;
  stdout: string;
  stderr: string;
  stdoutPath: string;
  stderrPath: string;
  exitCode: number | null;
  signal: string | null;
  error?: string;
  finished: Promise<void>;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
}
const processes = new Map<string, Entry>();
// An invocation owns its cancellation token before any asynchronous filesystem work.
const pendingStarts = new Set<{ scope: string; cancelled: boolean }>();
function snapshot(entry: Entry): Record<string, unknown> {
  return { ok: entry.status === "running" || entry.status === "stopped" || (entry.status === "exited" && entry.exitCode === 0), processId: entry.processId, ...(entry.filename ? { filename: entry.filename } : { path: entry.path }), args: entry.args, cwd: entry.cwd, status: entry.status, stdout: entry.stdout, stderr: entry.stderr, stdoutTruncated: false, stderrTruncated: false, stdoutPath: entry.stdoutPath, stderrPath: entry.stderrPath, exitCode: entry.exitCode, signal: entry.signal, ...(entry.error ? { error: entry.error } : {}) };
}
function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${key} must be a non-empty string without NUL characters`);
  return value;
}
function killGroup(entry: Entry): void {
  if (!entry.child.pid) return;
  try { process.kill(-entry.child.pid, "SIGKILL"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") entry.child.kill("SIGKILL");
  }
}
function stop(entry: Entry, status: "stopped" | "timeout"): void {
  if (entry.settled || entry.status === "stopped" || entry.status === "timeout") return;
  entry.status = status;
  killGroup(entry);
}
function lookup(input: Record<string, unknown>, scope: string): Entry {
  const entry = processes.get(requiredString(input, "processId"));
  if (!entry || entry.scope !== scope) throw new Error("Process not found in this conversation");
  return entry;
}
async function start(input: Record<string, unknown>, scope: string, token: { cancelled: boolean }, dataDir: string, open: boolean): Promise<Entry> {
  if ("command" in input || "code" in input) throw new Error("Inline code is not accepted; save a script with script_patch and provide filename");
  const cwd = open ? homedir() : requiredString(input, "cwd");
  if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error("cwd must be an existing absolute directory");
  const timeoutMs = input.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) throw new Error("timeoutMs must be a positive integer");
  const args = input.args ?? [];
  if (!Array.isArray(args) || args.some(value => typeof value !== "string" || value.includes("\0"))) throw new Error("args must be an array of strings without NUL characters");
  let filename: string | undefined, path: string | undefined, temporary: string | undefined;
  let executable: string, argv: string[];
  try {
    if (open) {
      path = requiredString(input, "path");
      if (!isAbsolute(path)) throw new Error("path must be absolute");
      await stat(path);
      if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("local.open supports macOS and Linux");
      executable = process.platform === "darwin" ? "/usr/bin/open" : "xdg-open";
      argv = [path];
    } else {
      filename = requiredString(input, "filename");
      const extension = extname(filename);
      const interpreters: Record<string, string> = { ".sh": "/bin/zsh", ".py": "python3", ".js": process.execPath, ".mjs": process.execPath, ".cjs": process.execPath };
      executable = interpreters[extension]!;
      if (!executable) throw new Error("Unsupported script extension; use .sh, .py, .js, .mjs, or .cjs");
      const script = await readScript(dataDir, filename);
      temporary = await mkdtemp(join(tmpdir(), "tchrome-script-run-"));
      const snapshotPath = join(temporary, `script${extension}`);
      await writeFile(snapshotPath, script.code, { mode: 0o600, flag: "wx" });
      argv = [snapshotPath, ...args];
    }
    if (token.cancelled) throw new Error("Local process start cancelled");
    const processId = allocateRecordId(dataDir, null, "process");
    const outputDir = join(resolve(dataDir), "process-output", processId);
    await mkdir(outputDir, { recursive: true });
    const stdoutPath = join(outputDir, "stdout.txt"), stderrPath = join(outputDir, "stderr.txt");
    await Promise.all([writeFile(stdoutPath, ""), writeFile(stderrPath, "")]);
    if (token.cancelled) throw new Error("Local process start cancelled");
    let done!: () => void;
    const finished = new Promise<void>((resolve) => { done = resolve; });
    const child = spawn(executable, argv, { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const entry: Entry = { processId, scope, filename, path, args, cwd, child, status: "running", stdout: "", stderr: "", stdoutPath, stderrPath, exitCode: null, signal: null, finished, settled: false };
    processes.set(entry.processId, entry);
    for (const key of ["stdout", "stderr"] as const) {
      const decoder = new StringDecoder("utf8");
      const append = (text: string) => {
        entry[key] += text;
        try { appendFileSync(key === "stdout" ? stdoutPath : stderrPath, text); }
        catch (error) { entry.error = `Failed to persist ${key}: ${error instanceof Error ? error.message : String(error)}`; entry.status = "error"; }
      };
      child[key].on("data", (chunk: Buffer) => append(decoder.write(chunk)));
      child[key].on("end", () => append(decoder.end()));
    }
    // EPIPE is expected when a command exits before consuming all of its input.
    child.stdin.on("error", () => {});
    child.on("error", (error) => { entry.error = error.message; entry.status = "error"; });
    child.on("exit", (code, signal) => {
      entry.exitCode = code;
      entry.signal = signal;
    });
    child.on("close", () => {
      if (temporary) rmSync(temporary, { recursive: true, force: true });
      entry.settled = true;
      clearTimeout(entry.timer);
      if (entry.status === "running") entry.status = "exited";
      done();
    });
    if (typeof timeoutMs === "number") {
      const deadline = Date.now() + timeoutMs;
      const checkTimeout = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) stop(entry, "timeout");
        else entry.timer = setTimeout(checkTimeout, Math.min(remaining, 2_147_483_647));
      };
      checkTimeout();
    }
    return entry;
  } catch (error) {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function abortLocalProcesses(scope: string): void {
  for (const token of pendingStarts) if (token.scope === scope) token.cancelled = true;
  for (const entry of processes.values()) if (entry.scope === scope) stop(entry, "stopped");
}
export function abortAllLocalProcesses(): void {
  for (const token of pendingStarts) token.cancelled = true;
  for (const entry of processes.values()) stop(entry, "stopped");
}

async function execute(name: string, rawInput: unknown, scope: string, dataDir: string): Promise<Record<string, unknown>> {
  if (!scope) throw new Error("Local tools require a conversation scope");
  const input = (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput : {}) as Record<string, unknown>;
  if (name === "local.capabilities") return { ok: true, platform: process.platform, home: homedir(), scriptExtensions: [".sh", ".py", ".js", ".mjs", ".cjs"], scriptExecution: "Save scripts with script_patch, then execute by filename. Each run uses an immutable private snapshot. Arguments are passed as literal strings.", outputRetention: "Complete stdout and stderr are retained and persisted in stdoutPath/stderrPath; process_status returns the complete cumulative output.", processLifetime: "No default timeout. An explicit timeoutMs, process_stop, conversation cancellation/deletion, or service shutdown terminates the process group. Parent exit does not terminate its children. local.run may pass heartbeatSec: when the process is still running after that many seconds, the call returns heartbeat=true with processId and previews instead of waiting; poll local.process_status until exit.", heartbeatNote: "heartbeatSec is seconds, positive integer; on successful exit the heartbeat ends with the process." };
  if (name === "local.run" || name === "local.process_start" || name === "local.open") {
    const token = { scope, cancelled: false };
    pendingStarts.add(token);
    try {
      const entry = await start(input, scope, token, dataDir, name === "local.open");
      pendingStarts.delete(token);
      if (name !== "local.process_start") {
        entry.child.stdin.end();
        const heartbeatSec = input.heartbeatSec;
        if (name === "local.run" && heartbeatSec !== undefined) {
          if (typeof heartbeatSec !== "number" || !Number.isSafeInteger(heartbeatSec) || heartbeatSec < 1) {
            throw new Error("heartbeatSec must be a positive integer number of seconds");
          }
          const startedAt = Date.now();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const raced = await Promise.race([
            entry.finished.then(() => "done" as const),
            new Promise<"heartbeat">((resolve) => {
              timer = setTimeout(() => resolve("heartbeat"), heartbeatSec * 1000);
            }),
          ]);
          if (timer) clearTimeout(timer);
          const stillRunning = entry.status === "running" && !entry.settled;
          if (raced === "heartbeat" && stillRunning) {
            const elapsedMs = Date.now() - startedAt;
            const tail = (value: string) => value.length <= 240 ? value : `…${value.slice(-240)}`;
            return {
              ...snapshot(entry),
              ok: true,
              heartbeat: true,
              status: "running",
              heartbeatSec,
              elapsedMs,
              stdoutPreview: tail(entry.stdout),
              stderrPreview: tail(entry.stderr),
              note: `仍在执行（已过 ${heartbeatSec}s）。processId=${entry.processId}。用 local.process_status 查询累计输出，用 local.process_stop 结束；进程退出后本心跳销毁。`,
            };
          }
        }
        await entry.finished;
      }
      return snapshot(entry);
    } finally { pendingStarts.delete(token); }
  }
  if (name === "local.process_status") return snapshot(lookup(input, scope));
  if (name === "local.process_stop") {
    const entry = lookup(input, scope);
    stop(entry, "stopped");
    await entry.finished;
    return snapshot(entry);
  }
  if (name === "local.process_write") {
    const entry = lookup(input, scope);
    if (entry.status !== "running" || entry.child.stdin.destroyed || entry.child.stdin.writableEnded) throw new Error("Process stdin is closed");
    if (typeof input.text !== "string") throw new Error("text must be a string");
    await new Promise<void>((resolve, reject) => {
      const stdin = entry.child.stdin;
      const finish = (error?: Error | null) => {
        stdin.off("error", onError);
        stdin.off("close", onClose);
        entry.child.off("exit", onClose);
        if (error) reject(error); else resolve();
      };
      const onError = (error: Error) => finish(error);
      const onClose = () => finish(new Error("Process stdin closed before write completed"));
      stdin.once("error", onError);
      stdin.once("close", onClose);
      entry.child.once("exit", onClose);
      try { stdin.write(input.text as string, finish); } catch (error) { finish(error as Error); }
    });
    if (input.end === true) entry.child.stdin.end();
    return snapshot(entry);
  }
  throw new Error(`Unknown local process tool: ${name}`);
}

export async function runLocalProcessTool(name: string, rawInput: unknown, scope: string, dataDir: string): Promise<Record<string, unknown>> {
  try { return await execute(name, rawInput, scope, dataDir); }
  catch (error) { return { ok: false, ...errorInfo(error), error: error instanceof Error ? error.message : String(error) }; }
}
