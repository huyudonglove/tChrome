import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolBridge } from "./bridge.ts";
import { handleTurn } from "./loop.ts";
import { deleteConversation, emptyLedger, loadLedger, loadTurn, newConversation, saveLedger, saveSession, stopTurn } from "./store.ts";
import type { CompletionResult, Provider } from "../types.ts";

const repoRoot = join(import.meta.dir, "../..");
const completed: CompletionResult = { finish: "tool_calls", content: "", attempts: 1, parseOk: true,
  schemaOk: true, faultCode: null, missing: [], toolCalls: [{ id: "finish", name: "finishTurn",
    arguments: { reason: "完成", affectsPage: false, text: "结果" } }] };

test("deleting a running conversation cannot reuse its identity or overwrite its replacement", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-lifecycle-"));
  const releases: ((result: CompletionResult) => void)[] = [];
  const provider: Provider = { complete: () => new Promise((resolve) => { releases.push(resolve); }) };
  const deps = { dataDir, repoRoot, provider };
  try {
    const old = handleTurn(deps, { userInput: "OLD", submittedAt: "now" });
    const replacement = deleteConversation(dataDir, "cv_01");
    expect(replacement.conversationId).toBe("cv_02");
    const next = handleTurn(deps, { userInput: "NEW", submittedAt: "now" });
    releases[0]!(completed);
    expect((await old).output).toEqual({ kind: "error", faultCode: "stopped" });
    expect(loadLedger(dataDir, "cv_02").status).toBe("running");
    expect(loadTurn(dataDir, "cv_02", "tn_01").input.text).toBe("NEW");
    releases[1]!(completed);
    expect((await next).output).toEqual({ kind: "reply", text: "结果" });
    expect(newConversation(dataDir).conversationId).toBe("cv_03");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("legacy conversation deletion records the watermark before removing its directory", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-legacy-ids-"));
  try {
    saveLedger(dataDir, emptyLedger("cv_42"));
    saveSession(dataDir, { conversationId: "cv_42" });
    expect(deleteConversation(dataDir, "cv_42").conversationId).toBe("cv_43");
    expect(deleteConversation(dataDir, "cv_43").conversationId).toBe("cv_44");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});


test("loop scopes bridge requests so stopping a queued conversation leaves the active one intact", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-scoped-loops-"));
  const bridge = createToolBridge();
  let calls = 0;
  const provider: Provider = { complete: async () => calls++ < 2
    ? { ...completed, toolCalls: [{ id: `page_${calls}`, name: "page.get_summary", arguments: { reason: "读取", affectsPage: false } }] }
    : completed };
  const deps = { dataDir, repoRoot, provider, host: bridge };
  try {
    const first = handleTurn(deps, { userInput: "FIRST", submittedAt: "now" });
    await Bun.sleep(0);
    const activeId = bridge.current()!.id;
    newConversation(dataDir);
    const second = handleTurn(deps, { userInput: "SECOND", submittedAt: "now" });
    await Bun.sleep(0);
    expect(bridge.current()!.id).toBe(activeId);
    stopTurn(dataDir);
    bridge.abort("cv_02");
    expect((await second).output).toEqual({ kind: "error", faultCode: "stopped" });
    expect(bridge.current()!.id).toBe(activeId);
    bridge.resolve(activeId, { ok: true });
    expect((await first).output).toEqual({ kind: "reply", text: "结果" });
    expect(loadLedger(dataDir, "cv_01").status).toBe("idle");
    expect(loadLedger(dataDir, "cv_02").status).toBe("paused");
  } finally { bridge.abort(); rmSync(dataDir, { recursive: true, force: true }); }
});
