import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.ts";
import { newConversation, loadLedger } from "./runtime/store.ts";

test("旧面板发送不能写入新会话", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-routing-"));
  try {
    const old = newConversation(dataDir);
    const current = newConversation(dataDir);
    const server = createServer({ dataDir });
    const response = await server.fetch(new Request("http://127.0.0.1:18788/turn", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: old.conversationId, userInput: "错误归属的消息" }),
    }));
    expect(response.status).toBe(409);
    expect(loadLedger(dataDir, current.conversationId!).turnIds).toEqual([]);
    expect(loadLedger(dataDir, old.conversationId!).turnIds).toEqual([]);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
