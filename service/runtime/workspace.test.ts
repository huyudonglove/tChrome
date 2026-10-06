import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatBoundId, groupWorkspaceEvidence } from "./workspace.ts";
import { handleTurn } from "./loop.ts";
import { ensureSession, loadLedger, saveLedger, loadTurn } from "./store.ts";
import type { CompletionResult, Provider, WorkspaceEntry } from "../types.ts";

const response = (toolCalls: CompletionResult["toolCalls"]): CompletionResult => ({
  finish: "tool_calls", content: "", toolCalls, attempts: 1,
  parseOk: true, schemaOk: true, faultCode: null, missing: [],
});

test("boundId formats as b01, b02, …", () => {
  expect(formatBoundId(1)).toBe("b01");
  expect(formatBoundId(123)).toBe("b123");
});

test("loop automatically records file evidence and reloads it across turns", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-ws-"));
  try {
    const path = join(dataDir, "source.txt");
    writeFileSync(path, "original evidence");
    const repoRoot = join(import.meta.dir, "../..");
    const { conversationId } = ensureSession(dataDir);
    const ledger = loadLedger(dataDir, conversationId);
    ledger.loadedToolIds = ["local_fs_read", "local_fs_write"];
    saveLedger(dataDir, ledger);
    let request = 0;
    const provider: Provider = { complete: async input => {
      request++;
      if (request === 1) return response([{ id: "read", name: "local_fs_read", arguments: { reason: "读取文件", items: [{ path }] } }]);
      if (request === 2) {
        const saved = loadLedger(dataDir, conversationId);
        const turn = loadTurn(dataDir, conversationId, saved.toolIO[0]!.turnId);
        const evidence = turn.assembled.workspace.find(entry => entry.target.key === path)!;
        expect(evidence).toMatchObject({ target: { kind: "file", key: path }, op: "local_fs_read", callId: saved.toolIO[0]!.callId });
        expect(evidence.content).toContain("original evidence");
        expect(input.messages[1]!.content).toContain("workspaceIds");
        expect(input.messages[1]!.content).toContain(evidence.id);
        return response([{ id: "write", name: "local_fs_write", arguments: { reason: "更新文件", path, content: "updated evidence" } }]);
      }
      return response([{ id: "finish", name: "finishTurn", arguments: { reason: "完成", text: "完成" } }]);
    } };
    const first = await handleTurn({ dataDir, repoRoot, provider }, { userInput: "读取并修改文件", submittedAt: "now" });
    expect(first.stopReason).toEqual({ kind: "reply", text: "完成" });
    expect(readFileSync(path, "utf8")).toBe("updated evidence");
    const saved = loadTurn(dataDir, conversationId, first.turnId);
    const entries = saved.assembled.workspace.filter(entry => entry.target.key === path);
    expect(entries.map(entry => entry.op)).toEqual(["local_fs_read", "local_fs_write"]);
    expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length);
    expect(entries.map(entry => entry.boundId)).toEqual(["b01", "b02"]);
    const groups = groupWorkspaceEvidence(entries);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.operations.map(op => op.content)).toEqual(["original evidence", "updated evidence"]);
    expect(groups[0]!.operations[1]!.revision).toBeGreaterThan(groups[0]!.operations[0]!.revision);
    const nextProvider: Provider = { complete: async input => {
      expect(input.messages[1]!.content).toContain("updated evidence");
      expect(input.messages[1]!.content).toContain(entries[0]!.id);
      return response([{ id: "done", name: "finishTurn", arguments: { reason: "完成", text: "完成" } }]);
    } };
    const second = await handleTurn({ dataDir, repoRoot, provider: nextProvider }, { userInput: "继续", submittedAt: "now" });
    expect(second.stopReason).toEqual({ kind: "reply", text: "完成" });
    expect(loadTurn(dataDir, conversationId, first.turnId).assembled.workspace).toEqual(saved.assembled.workspace);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});


test("identical evidence shares sources only before a mutation changes the revision", () => {
  const entry = (id: number, extra: Partial<WorkspaceEntry> = {}): WorkspaceEntry => ({
    id: `ws${id}`, turnId: "tn_01", boundId: `b0${id}`, callId: `call_0${id}`, callIds: [`call_0${id}`],
    target: { kind: "file", key: "/src/a.ts" }, op: "local_fs_read", result: { ok: true }, content: "same", ...extra,
  });
  const grouped = groupWorkspaceEvidence([
    entry(1, { args: { reason: "first" } }), entry(2, { args: { reason: "second", keepInCalls: true } }),
    entry(3, { op: "local_fs_write", mutation: true }), entry(4),
  ]);
  expect(grouped).toHaveLength(1);
  const operations = grouped[0]!.operations;
  expect(operations).toHaveLength(3);
  expect(operations[0]!.sources.map(source => source.id)).toEqual(["ws1", "ws2"]);
  expect(operations.map(operation => operation.revision)).toEqual([0, 1, 1]);
  expect(operations[2]!.sources.map(source => source.callId)).toEqual(["call_04"]);
});

test("browser mutations without a URL separate snapshots across the same tab", () => {
  const entry = (id: number, key: string, mutation = false): WorkspaceEntry => ({
    id: `ws${id}`, turnId: "tn_01", boundId: "b01", callId: `call_${id}`, callIds: [`call_${id}`],
    target: { kind: "browser", key, scope: "tab:12" }, op: mutation ? "page_click" : "page_get_summary",
    result: { ok: true }, content: "same page", ...(mutation ? { mutation } : {}),
  });
  const groups = groupWorkspaceEvidence([
    entry(1, "tab:12:url:A"), entry(2, "tab:12", true), entry(3, "tab:12:url:A"),
    entry(4, "tab:12:url:B"), entry(5, "tab:12:url:A"),
  ]);
  expect(groups[0]!.operations.map(operation => operation.revision)).toEqual([0, 1, 3]);
  expect(groups[0]!.operations.map(operation => operation.sources[0]!.callId)).toEqual(["call_1", "call_3", "call_5"]);
});
