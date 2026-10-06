import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runServiceTool } from "../tools/service-tools.ts";
import { extractWorkspaceEvidence } from "./workspace-extract.ts";

const extract = (name: string, args: Record<string, unknown>, result: unknown) => extractWorkspaceEvidence(name, args, JSON.stringify(result), "call_01");

test("batch reads retain actual ranges, budget metadata and failed item attribution", () => {
  const rows = extract("local_fs_read", { items: [{ path: "/repo/src/../a.ts" }, { path: "/repo/missing.ts" }] }, {
    ok: false, budgetNote: "cut", results: [
      { ok: true, path: "/repo/a.ts", content: "abc", startLine: 2, endLine: 3, totalLines: 20, truncatedForBudget: true },
      { ok: false, error: "missing", faultCode: "file_not_found" },
    ],
  });
  expect(rows[0]).toMatchObject({ target: { kind: "file", key: "/repo/a.ts" }, content: "abc", range: { startLine: 2, endLine: 3 }, result: { ok: true, totalLines: 20, truncatedForBudget: true } });
  expect(rows[0]!.result).not.toHaveProperty("content");
  expect(rows[1]).toMatchObject({ files: ["/repo/missing.ts"], result: { ok: false, error: "missing" } });
  expect(rows[2]!.result).toEqual({ ok: false, budgetNote: "cut" });
});

test("evidence retrieval attributes source locations but keeps directories and search metadata", () => {
  const rows = extract("evidence_search", { windows: [{ callId: "call_01" }, { callId: "call_02" }] }, {
    ok: true, results: [
      { ok: true, path: "/session/returns/call_01.txt", location: { path: "/repo/a.ts", startLine: 7, endLine: 8 }, kind: "content", content: "source" },
      { ok: true, path: "/session/returns/call_02.txt", kind: "directory", children: [{ blockId: "b1" }] },
    ],
  });
  expect(rows[0]).toMatchObject({ target: { kind: "file", key: "/repo/a.ts" }, content: "source", range: { startLine: 7, endLine: 8 } });
  expect(rows[1]).toMatchObject({ target: { kind: "tool", key: "call:call_01" }, result: { children: [{ blockId: "b1" }] } });
  const artifact = "/session/returns/call_01.txt";
  expect(extract("evidence_search", {}, { results: [{ path: artifact, location: { path: artifact }, content: "raw tool return" }] })[0]!.target.kind).toBe("tool");
});

test("grep groups actual matches without repeating them in whole-search status", () => {
  const matches = [{ path: "/repo/a.ts", line: 1, hit: "x" }, { path: "/repo/b.ts", line: 4, hit: "x" }, { path: "/repo/a.ts", line: 9, hit: "x" }];
  const rows = extract("local_fs_grep", { path: "/repo", query: "x" }, { ok: true, matches, skipped: [{ path: "/repo/x", reason: "binary" }], errors: [], truncated: true });
  expect(rows).toHaveLength(3);
  expect(rows[0]!.result).not.toHaveProperty("matches");
  expect(rows[0]!.result).toMatchObject({ truncated: true, skipped: [{ path: "/repo/x", reason: "binary" }] });
  expect(rows[1]).toMatchObject({ files: ["/repo/a.ts"], result: { matches: [matches[0], matches[2]] } });
});

test("write evidence separates complete writes, append and potentially partial failures", () => {
  const args = { path: "/repo/a", content: "new" };
  expect(extract("local_fs_write", args, { ok: true })[0]).toMatchObject({ content: "new", mutation: true });
  const append = extract("local_fs_write", { ...args, append: true }, { ok: true })[0]!;
  expect(append).not.toHaveProperty("content");
  expect(append).toMatchObject({ op: "local_fs_write:append", args: { content: "new", append: true }, mutation: true });
  const failed = extract("local_fs_write", args, { ok: false, error: "disk full" })[0]!;
  expect(failed).not.toHaveProperty("content");
  expect(failed.mutation).toBe(true);
});

test("copy and move track source and destination roles separately", () => {
  const args = { source: "/repo/a", destination: "/repo/b" };
  const copy = extract("local_fs_copy", args, { ok: true });
  expect(copy[0]).toMatchObject({ files: ["/repo/a"], op: "local_fs_copy:source" });
  expect(copy[0]!.mutation).toBeUndefined();
  expect(copy[1]).toMatchObject({ files: ["/repo/b"], mutation: true });
  expect(extract("local_fs_move", args, { ok: false }).every(row => row.mutation)).toBe(true);
});

test("relative paths and shell commands never invent source attribution", () => {
  expect(extract("local_fs_read", { items: [{ path: "relative.ts" }] }, { results: [{ ok: false }] })[0]!.target.kind).toBe("tool");
  const shell = extract("local_run", { command: "cat /repo/a" }, { path: "/tmp/script", stdoutPath: "/tmp/stdout", stdout: "data" })[0]!;
  expect(shell.target).toEqual({ kind: "tool", key: "call:call_01" });
  expect(shell.mutation).toBe(true);
  expect(extract("script_patch", { filename: "main.py" }, { ok: true })[0]).toMatchObject({ target: { kind: "script", key: "filename:main.py" }, mutation: true });
  expect(extract("see_page", { tabId: 12 }, { ok: true })[0]!.target).toEqual({ kind: "browser", key: "tab:12", scope: "tab:12" });
  expect(extractWorkspaceEvidence("unknown", {}, "not JSON", "call_01")[0]!.result).toBe("not JSON");
});

test("unidentified calls remain independent and preserve scalar, array and structured returns", () => {
  const a = extractWorkspaceEvidence("opaque", {}, '[1,{"x":false}]', "call_03")[0]!;
  const b = extractWorkspaceEvidence("opaque", {}, "null", "call_04")[0]!;
  expect(a.target).toEqual({ kind: "tool", key: "call:call_03" });
  expect(b.target.key).not.toBe(a.target.key);
  expect(a.result).toEqual([1, { x: false }]);
  expect(b.result).toBeNull();
});

test("script identities and their full code are retained without resolving relative filenames", () => {
  const code = "console.log('hello');\n";
  const read = extract("script_read", { filename: "task.js" }, { ok: true, filename: "task.js", code })[0]!;
  const write = extract("script_write", { filename: "task.js", code }, { ok: true, filename: "task.js", bytes: code.length })[0]!;
  expect(read.target).toEqual({ kind: "script", key: "filename:task.js" });
  expect(read.result).toEqual({ ok: true, filename: "task.js", code });
  expect(write.target).toEqual(read.target);
  expect(write.args!.code).toBe(code);
  expect(write.mutation).toBe(true);
  expect(extract("script_read", { path: "/scripts/sub/../task.js" }, { ok: true })[0]!.target).toEqual({ kind: "script", key: "path:/scripts/task.js" });
});

test("process and job identities group execution and status without losing cumulative output", () => {
  const result = { ok: false, processId: "proc_01", filename: "task.sh", stdout: "first\nsecond", stderr: "error", exitCode: 1 };
  const run = extract("local_run", { filename: "task.sh" }, result)[0]!;
  expect(run.target).toEqual({ kind: "process", key: "processId:proc_01" });
  expect(run.result).toEqual(result);
  const status = extract("local_process_status", { processId: "proc_01" }, result)[0]!;
  expect(status.target).toEqual(run.target);
  expect(status.mutation).toBeUndefined();
  expect(extract("local_process_stop", { processId: "proc_01" }, { ok: false, error: "failed" })[0]).toMatchObject({ target: run.target, mutation: true });
  const job = extract("execute_javascript", { tabId: 12, filename: "task.js" }, { jobId: "job_01", heartbeat: true })[0]!;
  expect(job.target).toEqual({ kind: "process", key: "jobId:job_01" });
  expect(extract("session_execute", {}, { sessionId: "exec_1", stdout: "data" })[0]!.target).toEqual({ kind: "process", key: "sessionId:exec_1" });
});

test("browser identities distinguish explicit navigation URLs and do not infer page URLs from network responses", () => {
  const before = extract("see_page", { tabId: 12 }, { tabId: 12, url: "https://example.com/a", content: "A" })[0]!;
  const after = extract("open_url", { tabId: 12, url: "https://example.com/b" }, { tabId: 12, url: "https://example.com/c" })[0]!;
  expect(before.target).toEqual({ kind: "browser", key: "tab:12:url:https://example.com/a", scope: "tab:12" });
  expect(after.target).toEqual({ kind: "browser", key: "tab:12:url:https://example.com/c", scope: "tab:12" });
  expect(after.mutation).toBe(true);
  expect(after.target.scope).toBe(before.target.scope);
  expect(extract("send_http", { url: "https://example.com/a" }, { ok: true })[0]!.target).toEqual({ kind: "browser", key: "url:https://example.com/a" });
  expect(extract("wait_response", { tabId: 12 }, { tabId: 12, url: "https://api.example.com/data" })[0]!.target).toEqual({ kind: "browser", key: "tab:12", scope: "tab:12" });
});

test("declared browser mutations and executions establish boundaries even on failures", () => {
  const writes = ["page_type", "page_fill_role", "page_select_role", "page_click_role", "page_click_text", "page_fill_submit", "page_submit_wait", "page_drag_to_id", "local_run", "local_process_start"];
  for (const name of writes) expect(extract(name, { tabId: 12 }, { ok: false, error: "partial operation" })[0]!.mutation).toBe(true);
  for (const name of ["page_get_summary", "page_list_interactive_elements", "page_assert", "script_read", "local_process_status"]) {
    expect(extract(name, {}, { ok: true })[0]!.mutation).toBeUndefined();
  }
});

test("actual script service write and read contracts preserve full code and status", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "workspace-script-evidence-"));
  try {
    const args = { filename: "full.js", code: "// 正文\n" + "console.log('full');\n".repeat(500) };
    const written = await runServiceTool(dataDir, "script_write", args);
    const write = extract("script_write", args, written)[0]!;
    expect(written.ok).toBe(true);
    expect(write.result).toEqual(written);
    expect(write.args!.code).toBe(args.code);
    expect(write.mutation).toBe(true);
    const returned = await runServiceTool(dataDir, "script_read", { filename: args.filename });
    const read = extract("script_read", { filename: args.filename }, returned)[0]!;
    expect(returned.ok).toBe(true);
    expect(read.result).toEqual(returned);
    expect((read.result as Record<string, unknown>).code).toBe(args.code);
    expect(read.target).toEqual(write.target);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("externalized returns keep the admitted pointer and never attribute its storage path as the source", () => {
  const pointer = { ok: true, externalized: true, path: "/data/returns/call_01.txt", directory: { kind: "directory", children: [] } };
  const [entry] = extractWorkspaceEvidence("local_fs_write", { path: "/src/file.txt", content: "original content" }, JSON.stringify(pointer), "call_01");
  expect(entry!.target).toEqual({ kind: "file", key: "/src/file.txt" });
  expect(entry!.result).toEqual(pointer);
  expect(entry!.content).toBeUndefined();
  const [script] = extractWorkspaceEvidence("script_read", { filename: "task.js" }, JSON.stringify(pointer), "call_02");
  expect(script!.target).toEqual({ kind: "script", key: "filename:task.js" });
  expect(script!.files).toBeUndefined();
  expect(script!.result).toEqual(pointer);
});
