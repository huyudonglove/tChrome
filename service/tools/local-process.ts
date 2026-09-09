import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

export const LOCAL_PROCESS_TOOL_NAMES = ["local.run", "local.process_start", "local.process_status", "local.process_write", "local.process_stop", "local.open", "local.capabilities"] as const;
const OUTPUT_LIMIT = 65_536;
const MAX_RUNNING = 8;
const MAX_FINISHED = 64;
type Status = "running" | "exited" | "error" | "timeout" | "stopped";
interface Entry {
  processId: string;
  scope: string;
  command: string;
  cwd: string;
  child: ChildProcessWithoutNullStreams;
  status: Status;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
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
  return { ok: entry.status === "running" || entry.status === "stopped" || (entry.status === "exited" && entry.exitCode === 0), processId: entry.processId, command: entry.command, cwd: entry.cwd, status: entry.status, stdout: entry.stdout, stderr: entry.stderr, stdoutTruncated: entry.stdoutTruncated, stderrTruncated: entry.stderrTruncated, exitCode: entry.exitCode, signal: entry.signal, ...(entry.error ? { error: entry.error } : {}), outputLimit: OUTPUT_LIMIT };
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
  if (entry.status !== "running") return;
  entry.status = status;
  killGroup(entry);
}
function prune(): void {
  const finished = [...processes.values()].filter((entry) => entry.settled);
  for (const entry of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) processes.delete(entry.processId);
}
function lookup(input: Record<string, unknown>, scope: string): Entry {
  const entry = processes.get(requiredString(input, "processId"));
  if (!entry || entry.scope !== scope) throw new Error("Process not found in this conversation");
  return entry;
}
async function start(input: Record<string, unknown>, scope: string, token: { cancelled: boolean }): Promise<Entry> {
  const command = requiredString(input, "command");
  const cwd = requiredString(input, "cwd");
  if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error("cwd must be an existing absolute directory");
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error("timeoutMs must be an integer between 1 and 300000");
  if ([...processes.values()].filter((entry) => !entry.settled).length >= MAX_RUNNING) throw new Error("Maximum 8 local processes can run concurrently");
  if (token.cancelled) throw new Error("Local process start cancelled");
  let done!: () => void;
  const finished = new Promise<void>((resolve) => { done = resolve; });
  const child = spawn("/bin/zsh", ["-lc", command], { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const entry: Entry = { processId: crypto.randomUUID(), scope, command, cwd, child, status: "running", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, exitCode: null, signal: null, finished, settled: false };
  processes.set(entry.processId, entry);
  for (const key of ["stdout", "stderr"] as const) {
    const decoder = new StringDecoder("utf8");
    const append = (text: string) => {
      entry[key] += text;
      if (entry[key].length > OUTPUT_LIMIT) {
        entry[key] = entry[key].slice(-OUTPUT_LIMIT);
        entry[key === "stdout" ? "stdoutTruncated" : "stderrTruncated"] = true;
      }
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
    // Commands cannot leave detached shell children alive after their leader exits.
    killGroup(entry);
  });
  child.on("close", () => {
    entry.settled = true;
    clearTimeout(entry.timer);
    if (entry.status === "running") entry.status = "exited";
    done();
    prune();
  });
  entry.timer = setTimeout(() => stop(entry, "timeout"), timeoutMs);
  return entry;
}

export function abortLocalProcesses(scope: string): void {
  for (const token of pendingStarts) if (token.scope === scope) token.cancelled = true;
  for (const entry of processes.values()) if (entry.scope === scope) stop(entry, "stopped");
}
export function abortAllLocalProcesses(): void {
  for (const token of pendingStarts) token.cancelled = true;
  for (const entry of processes.values()) stop(entry, "stopped");
}

async function execute(name: string, rawInput: unknown, scope: string): Promise<Record<string, unknown>> {
  if (!scope) throw new Error("Local tools require a conversation scope");
  const input = (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput : {}) as Record<string, unknown>;
  if (name === "local.capabilities") return { ok: true, platform: process.platform, home: homedir(), shell: "/bin/zsh", defaultTimeoutMs: 30_000, maxTimeoutMs: 300_000, maxConcurrentProcesses: MAX_RUNNING, outputLimit: OUTPUT_LIMIT, outputRetention: "Last 65536 characters of stdout and stderr, continuously drained; process_status returns the complete retained snapshot.", processLifetime: "Background processes end on timeout, conversation cancellation/deletion, or service shutdown. Child processes are killed when their command exits." };
  if (name === "local.run" || name === "local.process_start" || name === "local.open") {
    const token = { scope, cancelled: false };
    pendingStarts.add(token);
    try {
      let args = input;
      if (name === "local.open") {
        const path = requiredString(input, "path");
        if (!isAbsolute(path)) throw new Error("path must be absolute");
        await stat(path);
        if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("local.open supports macOS and Linux");
        const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
        args = { command: `${process.platform === "darwin" ? "/usr/bin/open" : "xdg-open"} ${quote(path)}`, cwd: homedir() };
      }
      const entry = await start(args, scope, token);
      pendingStarts.delete(token);
      if (name !== "local.process_start") {
        entry.child.stdin.end();
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
    if (input.text.length > OUTPUT_LIMIT) throw new Error("text must not exceed 65536 characters per write");
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

export async function runLocalProcessTool(name: string, rawInput: unknown, scope: string): Promise<Record<string, unknown>> {
  try { return await execute(name, rawInput, scope); }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}
