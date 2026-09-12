import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchScript } from "../scripts/store.ts";
import { abortAllLocalProcesses, abortLocalProcesses, runLocalProcessTool } from "./local-process";

let cwd: string;
let scope: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "tchrome-process-"));
  scope = crypto.randomUUID();
});
afterEach(async () => {
  abortAllLocalProcesses();
  await rm(cwd, { recursive: true, force: true });
});
const call = (name: string, input: Record<string, unknown> = {}, owner = scope) => runLocalProcessTool(`local.${name}`, input, owner, cwd);
let scriptId = 0;
async function script(code: string, extension = "sh") {
  const filename = `test-${++scriptId}.${extension}`;
  const lines = code.split("\n");
  expect(await patchScript(cwd, { filename, patch: `--- /dev/null\n+++ b/${filename}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => "+" + line).join("\n")}\n` })).toMatchObject({ ok: true });
  return filename;
}
async function waitFor(processId: unknown, predicate: (value: Record<string, unknown>) => boolean) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = await call("process_status", { processId });
    if (predicate(value)) return value;
    await Bun.sleep(10);
  }
  throw new Error("Process did not reach expected state");
}

test("foreground commands capture both streams, cwd, and exit status", async () => {
  const result = await call("run", { filename: await script("pwd; printf hello; printf error >&2; exit 7"), cwd });
  expect(result.status).toBe("exited");
  expect(result.exitCode).toBe(7);
  expect(result.ok).toBe(false);
  expect(String(result.stdout)).toContain("hello");
  expect(String(result.stdout)).toContain(cwd.replace(/^\/var\//, "/private/var/"));
  expect(result.stderr).toBe("error");
});

test.each([
  ["sh", 'printf "%s" "$1"'],
  ["py", 'import sys; print(sys.argv[1], end="")'],
  ["js", 'process.stdout.write(process.argv[2]);'],
  ["mjs", 'process.stdout.write(process.argv[2]);'],
  ["cjs", 'process.stdout.write(process.argv[2]);'],
])("%s scripts receive literal arguments through their fixed interpreter", async (extension, code) => {
  const filename = await script(code!, extension);
  const value = "$(touch injected); ' spaced argument";
  expect(await call("run", { filename, cwd, args: [value] })).toMatchObject({ ok: true, filename, stdout: value });
  expect(await Bun.file(join(cwd, "injected")).exists()).toBe(false);
});

test("rejects inline code, missing scripts and invalid arguments", async () => {
  const filename = await script("printf valid");
  for (const input of [{ command: "printf bypass" }, { filename, command: "printf bypass" }, { filename, code: "printf bypass" },
    { filename: "missing.sh" }, { filename: "../escape.sh" }, { filename: "file.txt" }, { filename, args: [1] }]) {
    expect(await call("run", { cwd, ...input })).toMatchObject({ ok: false });
  }
});

test("background execution retains its snapshot after the saved script is patched", async () => {
  const filename = await script('read value\nprintf "old:%s" "$value"');
  const started = await call("process_start", { filename, cwd });
  expect(started.status).toBe("running");
  expect(await patchScript(cwd, { filename, patch: `--- a/${filename}\n+++ b/${filename}\n@@ -1,2 +1,2 @@\n read value\n-printf "old:%s" "$value"\n+printf "new:%s" "$value"\n` })).toMatchObject({ ok: true });
  await call("process_write", { processId: started.processId, text: "value\n", end: true });
  expect(await waitFor(started.processId, value => value.status === "exited")).toMatchObject({ stdout: "old:value" });
});

test("stdout and stderr continuously drain with bounded retained tails", async () => {
  const result = await call("run", { filename: await script("yes x | head -c 200000; printf END; yes e | head -c 200000 >&2; printf ERR >&2"), cwd });
  expect(result.exitCode).toBe(0);
  expect(result.ok).toBe(true);
  expect(String(result.stdout).length).toBe(65536);
  expect(String(result.stderr).length).toBe(65536);
  expect(String(result.stdout).endsWith("END")).toBe(true);
  expect(String(result.stderr).endsWith("ERR")).toBe(true);
  expect(result.stdoutTruncated).toBe(true);
  expect(result.stderrTruncated).toBe(true);
});

test("timeout kills the shell's children as well as the shell", async () => {
  const result = await call("run", { filename: await script("sleep 30 & echo $! > child.pid; wait"), cwd, timeoutMs: 250 });
  expect(result.status).toBe("timeout");
  expect(result.ok).toBe(false);
  expect(result.signal).toBe("SIGKILL");
  const pid = Number(await readFile(join(cwd, "child.pid"), "utf8"));
  await Bun.sleep(30);
  expect(() => process.kill(pid, 0)).toThrow();
});

test("background stdin and EOF reach command; other scopes cannot read or mutate it", async () => {
  const started = await call("process_start", { filename: await script("cat"), cwd });
  expect(started.status).toBe("running");
  const processId = started.processId;
  for (const name of ["process_status", "process_write", "process_stop"]) {
    expect(await call(name, { processId, text: "unwanted" }, "another-conversation")).toMatchObject({ ok: false, error: expect.stringContaining("not found") });
  }
  await call("process_write", { processId, text: "hello\n", end: true });
  const result = await waitFor(processId, (value) => value.status === "exited");
  expect(result.stdout).toBe("hello\n");
  expect(result.exitCode).toBe(0);
  expect(result.ok).toBe(true);
});

test("background processes time out and cancellation stops only its scope", async () => {
  const timed = await call("process_start", { filename: await script("sleep 30"), cwd, timeoutMs: 100 });
  await waitFor(timed.processId, (value) => value.status === "timeout" && value.signal === "SIGKILL");
  const own = await call("process_start", { filename: await script("sleep 30"), cwd });
  const other = await call("process_start", { filename: await script("sleep 30"), cwd }, "other");
  abortLocalProcesses(scope);
  await waitFor(own.processId, (value) => value.status === "stopped" && value.signal === "SIGKILL");
  expect((await call("process_status", { processId: other.processId }, "other")).status).toBe("running");
  expect((await call("process_stop", { processId: other.processId }, "other")).status).toBe("stopped");
});

test("validates directory, timeout, and global concurrency bound", async () => {
  expect(await call("run", { filename: await script("echo bad"), cwd: "." })).toMatchObject({ ok: false, error: expect.stringContaining("absolute") });
  expect(await call("run", { filename: await script("echo bad"), cwd, timeoutMs: 300001 })).toMatchObject({ ok: false, error: expect.stringContaining("timeoutMs") });
  const running = [];
  for (let i = 0; i < 8; i++) running.push(await call("process_start", { filename: await script("sleep 30"), cwd }));
  expect(await call("process_start", { filename: await script("sleep 30"), cwd })).toMatchObject({ ok: false, error: expect.stringContaining("Maximum 8") });
  abortAllLocalProcesses();
  for (const entry of running) await waitFor(entry.processId, (value) => value.signal === "SIGKILL");
});

test("cancelling during the asynchronous directory check prevents spawning", async () => {
  const filename = await script("touch should-not-exist");
  const pending = call("process_start", { filename, cwd });
  abortLocalProcesses(scope);
  expect(await pending).toMatchObject({ ok: false, error: "Local process start cancelled" });
  expect(await Bun.file(join(cwd, "should-not-exist")).exists()).toBe(false);
  const allPending = call("process_start", { filename, cwd });
  abortAllLocalProcesses();
  expect(await allPending).toMatchObject({ ok: false, error: "Local process start cancelled" });
  // A later invocation in the same conversation remains usable.
  expect(await call("run", { filename: await script("printf resumed"), cwd })).toMatchObject({ ok: true, stdout: "resumed" });
});

test("blocked stdin writes finish when a process times out", async () => {
  const started = await call("process_start", { filename: await script("sleep 30"), cwd, timeoutMs: 100 });
  const results = [];
  for (let i = 0; i < 128; i++) {
    const result = await call("process_write", { processId: started.processId, text: "x".repeat(65536) });
    results.push(result);
    if (result.ok === false) break;
  }
  expect(results.some((result) => result.ok === false)).toBe(true);
  expect(await waitFor(started.processId, (value) => value.status === "timeout" && value.signal === "SIGKILL")).toMatchObject({ ok: false });
});
