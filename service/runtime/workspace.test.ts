import { expect, test } from "bun:test";
import {
  buildWorkspaceSuggestion,
  defaultWorkspaceCallIds,
  formatBoundId,
  WORKSPACE_SUGGEST_MARKER,
} from "./workspace.ts";
import { emptyLedger } from "./store.ts";
import type { ToolIOItem } from "../types.ts";

const row = (name: string, callId: string, batchId = "batch_01"): ToolIOItem => ({
  callId,
  batchId,
  name,
  arguments: {},
  turnId: "tn_01",
  return: { stage: "complete", totalChars: 1, text: "ok" },
});

test("boundId formats as b01, b02, …", () => {
  expect(formatBoundId(1)).toBe("b01");
  expect(formatBoundId(2)).toBe("b02");
  expect(formatBoundId(123)).toBe("b123");
});

test("suggestion names the batch and tallies tools, without echoing runtime-filled fields", () => {
  const text = buildWorkspaceSuggestion([
    row("local_fs_read", "call_01"),
    row("local_fs_read", "call_02"),
    row("local_fs_grep", "call_03"),
  ])!;
  expect(text).toContain(WORKSPACE_SUGGEST_MARKER);
  expect(text).toContain("3 次调用");
  expect(text).toContain("local_fs_read×2");
  expect(text).toContain("workspace_write");
  // boundId / callIds 写入时由 Runtime 反填，模型不需要抄，建议里不该出现。
  expect(text).not.toContain("boundId=");
  expect(text).not.toContain("callIds=");
});

test("pure bookkeeping batches get no suggestion", () => {
  expect(buildWorkspaceSuggestion([row("observation_write", "call_01"), row("finishTurn", "call_02")])).toBeNull();
  expect(buildWorkspaceSuggestion([])).toBeNull();
});

test("suggestion lists batch files for copying into files[]", () => {
  const read: ToolIOItem = { ...row("local_fs_read", "call_01"), arguments: { reason: "读", items: [{ path: "src/auth.ts" }] } };
  const write: ToolIOItem = { ...row("local_fs_write", "call_02"), arguments: { reason: "写", path: "src/auth.ts" } };
  const text = buildWorkspaceSuggestion([read, write])!;
  expect(text).toContain("本批涉及文件：src/auth.ts");
  const noFiles = buildWorkspaceSuggestion([row("page_click", "call_03")])!;
  expect(noFiles).not.toContain("本批涉及文件");
});

test("default callIds are the business calls of the latest batch", () => {
  const ledger = emptyLedger("cv_ws");
  ledger.toolIO.push(
    row("see_page", "call_01", "batch_01"),
    row("observation_write", "call_02", "batch_01"),
    row("local_fs_read", "call_03", "batch_02"),
    row("workspace_write", "call_04", "batch_02"),
  );
  // workspace_write 自身是中性，不会把自己算进被总结的调用。
  expect(defaultWorkspaceCallIds(ledger, "tn_01")).toEqual(["call_03"]);
  expect(defaultWorkspaceCallIds(emptyLedger("cv_empty"), "tn_01")).toEqual([]);
});

test("loop appends one suggestion per batch, model writes ws, window shows it once", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { handleTurn } = await import("./loop.ts");
  const { ensureSession, loadLedger, saveLedger } = await import("./store.ts");
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-ws-"));
  try {
    const repoRoot = join(import.meta.dir, "../..");
    const session = ensureSession(dataDir);
    const primed = loadLedger(dataDir, session.conversationId);
    primed.loadedToolIds = ["local_fs_list", "local_fs_read"];
    saveLedger(dataDir, primed);
    const seen: string[] = [];
    let n = 0;
    const result = (partial: Record<string, unknown>) => ({
      finish: "tool_calls", content: "", toolCalls: [], attempts: 1,
      parseOk: true, schemaOk: true, faultCode: null, missing: [], ...partial,
    });
    const provider = {
      complete: async (input: { messages: { content: string }[] }) => {
        n++;
        seen.push(input.messages[1]!.content);
        if (n === 1) return result({ toolCalls: [
          { id: "a", name: "local_fs_list", arguments: { reason: "看目录", path: dataDir } },
          { id: "b", name: "local_fs_read", arguments: { reason: "读", items: [{ path: join(dataDir, "nope.txt") }] } },
        ] });
        if (n === 2) {
          const notices = loadLedger(dataDir, session.conversationId).runtimeNotices;
          expect(notices).toHaveLength(1);
          expect(notices[0]).toMatchObject({ id: "rt_01", kind: "workspace" });
          expect(input.messages[1]!.content).toContain(`<notice id="${notices[0]!.id}" kind="workspace"`);
          return result({ toolCalls: [
            { id: "c", name: "workspace_write", arguments: { reason: "补记", op: "列了目录", value: "空目录" } },
          ] });
        }
        return result({ toolCalls: [
          { id: "d", name: "finishTurn", arguments: { reason: "完", text: "完成" } },
        ] });
      },
    };
    const reply = await handleTurn({ dataDir, repoRoot, provider } as never, { userInput: "整理", submittedAt: "2026-09-11" });
    expect(reply.stopReason).toEqual({ kind: "reply", text: "完成" });
    const ledger = loadLedger(dataDir, reply.conversationId);
    // 三次出网，boundSeq 计三次。
    expect(ledger.boundSeq).toBe(3);
    // b02 的请求在 <runtime> 模块看到 b01 那批的建议（不再缀在返回后面）。
    expect(seen[1]).toContain("<runtime>");
    expect(seen[1]).toContain('kind="workspace"');
    expect(seen[1]).toContain(WORKSPACE_SUGGEST_MARKER);
    // ws 写下后进窗口，且同 kind 只保留最新一条。
    expect(seen[2]!).toContain('<workspaces start="ws01" end="ws01">');
    expect(seen[2]!).toContain('boundid="b02"');
    expect(seen[2]!.split(WORKSPACE_SUGGEST_MARKER).length - 1).toBeLessThanOrEqual(1);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
