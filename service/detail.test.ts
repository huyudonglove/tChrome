import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTurn } from "./runtime/loop.ts";
import { ensureSession, loadLedger } from "./runtime/store.ts";
import { compressRecords } from "./compression/compress.ts";
import { loadIndex } from "./compression/store.ts";
import type { CompletionResult, Provider } from "./types.ts";

const repoRoot = join(import.meta.dir, "..");
const full = "详细内容".repeat(1000) + "末尾证据";
const reply = (value: Partial<CompletionResult>): CompletionResult => ({ content: "", finish: "stop", toolCalls: [], attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [], ...value });

test("delegated query returns archived originals to next main request without truncation or ids", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-query-loop-"));
  try {
    const session = ensureSession(dataDir);
    await compressRecords({ dataDir, conversationId: session.conversationId, repoRoot, module: "toolIO",
      records: [{ id: "source_tool", content: { callId: "hidden_call", text: full } }],
      provider: { complete: async () => reply({ content: JSON.stringify({ tag: "详情", summary: "详细证据" }) }) },
    });
    const id = loadIndex(dataDir, session.conversationId, "toolIO").activeIds[0]!;
    let requests = 0, queries = 0;
    const provider: Provider = { complete: async ({ messages, tools }) => {
      if (!tools.length) { queries++; return reply({ content: JSON.stringify({ ids: [id] }) }); }
      requests++;
      if (requests === 2) {
        expect(JSON.stringify(messages)).toContain(full);
        expect(messages[1]!.content).not.toContain("hidden_call");
      }
      return reply({ finish: "tool_calls", toolCalls: requests === 1
        ? [{ id: "detail", name: "context.query", arguments: { reason: "查看完整证据", affectsPage: false, module: "toolIO", tag: "详情", question: "完整证据是什么" } }]
        : [{ id: "finish", name: "finishTurn", arguments: { reason: "已读", affectsPage: false, text: "完成" } }] });
    } };
    const result = await handleTurn({ repoRoot, dataDir, provider }, { userInput: "读取详情", submittedAt: new Date().toISOString() });
    expect(result.output).toEqual({ kind: "reply", text: "完成" });
    expect(requests).toBe(2);
    expect(queries).toBe(1);
    const row = loadLedger(dataDir, session.conversationId).toolIO.find(item => item.name === "context.query")!;
    expect(row.return.stage).toBe("complete");
    expect(JSON.parse(row.return.text).contents[0].text).toBe(full);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
