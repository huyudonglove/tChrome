import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleTurn } from "./runtime/loop.ts";
import type { Provider } from "./types.ts";

test("model requests carry tool documentation only in tools, including after catalog loading", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-model-input-"));
  let requests = 0;
  const provider: Provider = { complete: async ({ messages, tools }) => {
    requests++;
    const text = messages.map(message => message.content).join("\n");
    expect(text).not.toMatch(/^#(?:baseTools|tools)\b/m);
    for (const tool of tools) {
      expect(tool.function.description?.length ?? 0).toBeGreaterThan(0);
      expect(text).not.toContain(tool.function.description!);
    }
    if (requests === 2) expect(tools.map(tool => tool.function.name)).toContain("send_http");
    return { finish: "tool_calls", content: "", attempts: 1, parseOk: true, schemaOk: true,
      faultCode: null, missing: [], toolCalls: requests === 1
        ? [{ id: "load", name: "catalog.add", arguments: { names: ["send_http"], reason: "读取接口" } }]
        : [{ id: "done", name: "finishTurn", arguments: { text: "完成", reason: "答复", affectsPage: false } }] };
  } };
  try {
    const result = await handleTurn({ dataDir, repoRoot: join(import.meta.dir, ".."), provider }, { userInput: "检查接口", submittedAt: "now" });
    expect(result.output).toEqual({ kind: "reply", text: "完成" });
    expect(requests).toBe(2);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
