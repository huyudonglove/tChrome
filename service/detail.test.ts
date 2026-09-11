import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTurn } from "./runtime/loop.ts";
import { ensureSession, loadLedger, saveFullReturn, saveObservation } from "./runtime/store.ts";
import { clipReturn } from "./tools/execute.ts";
import type { CompletionResult, Provider } from "./types.ts";

const repoRoot = join(import.meta.dir, "..");
const full = "详细内容".repeat(1000) + "末尾证据";

for (const kind of ["tool", "observation"]) {
  test(`record.query ${kind} 分页结果进入下一次模型窗口，不再次截断`, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "tchrome-detail-"));
    try {
      const session = ensureSession(dataDir);
      saveFullReturn(dataDir, session.conversationId, "source", full);
      saveObservation(dataDir, session.conversationId, {
        observationId: "ob_01", text: "摘要", full, sourceCallIds: ["source"],
        totalChars: full.length, createdAt: new Date().toISOString(),
      });
      let requests = 0;
      const provider: Provider = {
        complete: async ({ messages }): Promise<CompletionResult> => {
          requests += 1;
          if (requests === 2) expect(JSON.stringify(messages)).toContain(full);
          return {
            content: "", finish: "tool_calls", attempts: 1, parseOk: true, schemaOk: true,
            faultCode: null, missing: [],
            toolCalls: requests === 1 ? [{
              id: "detail", name: "record.query",
              arguments: { reason: "查看完整证据", affectsPage: false,
                mode: "read", kind, id: kind === "tool" ? "source" : "ob_01", offset: 0, limit: 10000 },
            }] : [{ id: "finish", name: "finishTurn", arguments: {
              reason: "证据已读", affectsPage: false, text: "完成",
            } }],
          };
        },
      };
      await handleTurn({ repoRoot, dataDir, provider }, {
        userInput: "读取详情", submittedAt: new Date().toISOString(),
      });
      expect(requests).toBe(2);
      const row = loadLedger(dataDir, session.conversationId).toolIO.find((item) => item.callId === "detail");
      expect(row?.return.stage).toBe("complete");
      expect(JSON.parse(row!.return.text).text).toBe(full);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
}

test("普通工具返回继续截断", () => {
  expect(clipReturn(full)).toEqual({ stage: "truncated", totalChars: full.length, text: full.slice(0, 2000) });
});
