import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.ts";
import { newConversation, loadLedger } from "./runtime/store.ts";

const reply = { finish: "tool_calls" as const, content: "", toolCalls: [{ id: "reply", name: "finishTurn", arguments: { text: "完成" } }], attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [] };
const post = (route: string, body: unknown) => new Request(`http://127.0.0.1:18788${route}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

test("面板按 conversationId 发送，消息写入自己打开的会话而不是当前会话", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-routing-"));
  try {
    const old = newConversation(dataDir);
    const current = newConversation(dataDir);
    const server = createServer({ dataDir, provider: { complete: async () => reply } });
    const response = await server.fetch(post("/turn", { conversationId: old.conversationId, userInput: "面板 A 的消息", submittedAt: "now" }));
    expect(response.status).toBe(200);
    expect((await response.json()).stopReason.kind).toBe("reply");
    expect(loadLedger(dataDir, old.conversationId!).turnIds).toHaveLength(1);
    expect(loadLedger(dataDir, current.conversationId!).turnIds).toEqual([]);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("/turn 传不存在的会话直接拒绝，不落到当前会话", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-routing-unknown-"));
  try {
    const current = newConversation(dataDir);
    const server = createServer({ dataDir, provider: { complete: async () => reply } });
    const response = await server.fetch(post("/turn", { conversationId: "cv_missing", userInput: "无主消息", submittedAt: "now" }));
    expect(response.status).toBe(404);
    expect((await response.json()).stopReason.faultCode).toBe("unknown_conversation");
    expect(loadLedger(dataDir, current.conversationId!).turnIds).toEqual([]);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("/session 按查询参数返回对应会话视图", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-routing-session-"));
  try {
    const old = newConversation(dataDir);
    newConversation(dataDir);
    const server = createServer({ dataDir });
    const requested = await (await server.fetch(new Request(`http://127.0.0.1:18788/session?conversationId=${old.conversationId}`))).json();
    expect(requested.conversationId).toBe(old.conversationId);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("/stop 按 conversationId 停止对应会话，不影响其他会话", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-stop-routing-"));
  try {
    const old = newConversation(dataDir);
    const current = newConversation(dataDir);
    const aborted: (string | undefined)[] = [];
    const server = createServer({ dataDir, host: { execute: async () => ({ ok: true }), abort: scope => aborted.push(scope) } });
    await server.fetch(post("/stop", { conversationId: old.conversationId }));
    expect(aborted).toEqual([old.conversationId]);
    expect(loadLedger(dataDir, current.conversationId!).status).toBe("idle");
    await server.fetch(post("/stop", { conversationId: "cv_missing" }));
    expect(aborted).toEqual([old.conversationId]);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
