import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function compressionLog(dataDir: string, conversationId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(conversationId)) throw new Error("Invalid compression log conversationId");
  const dir = join(dataDir, "conversations", conversationId, "agent-logs", "compression");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${Date.now()}-${randomUUID()}.jsonl`);
  return {
    path,
    append(stage: string, data: unknown) {
      appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), stage, data })}\n`, { mode: 0o600 });
    },
  };
}
