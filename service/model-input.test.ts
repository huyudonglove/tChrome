import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadLedger, newConversation, openConversation } from "./runtime/store.ts";
import { handleTurn } from "./runtime/loop.ts";
import type { Provider } from "./types.ts";
import { coreToolIds, loadToolRegistry } from "./tools/registry.ts";

test("resident and dynamic guides remain separate, persist loaded schemas across turns and reopen while isolating new conversations", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-model-input-"));
  const registry = loadToolRegistry(join(import.meta.dir, ".."));
  let requests = 0;
  let initialSystem = "";
  const provider: Provider = { complete: async ({ messages, tools }) => {
    requests++;
    const system = messages[0]!.content;
    const user = messages[1]!.content;
    const baseBlock = system.match(/<baseTools>\n([\s\S]*?)\n<\/baseTools>/)![1]!;
    const baseGuide = baseBlock.split(/\n\nSample[\s\S]*$/)[0]!.split("\n\n").at(-1)!;
    const dynamicGuide = user.match(/<tools>\n[\s\S]*?\n\n内容：\n([\s\S]*?)\n<\/tools>/)![1]!;
    const names = (guide: string) => [...guide.matchAll(/^- ([^：]+)：/gm)].map(match => match[1]);
    expect(names(baseGuide)).toEqual(registry.toolGroups.baseToolsIds);
    expect(names(dynamicGuide)).toEqual([...coreToolIds(registry), ...([2, 3, 5].includes(requests) ? ["send_http"] : [])]);
    expect(user).not.toContain("<baseTools>");
    expect(system).toContain("<systemSkill>");
    if (requests === 1) initialSystem = system;
    else expect(system).toBe(initialSystem);
    for (const tool of tools) {
      expect(tool.function.description?.length ?? 0).toBeGreaterThan(0);
    }
    expect(baseGuide).not.toContain("参数：");
    expect(dynamicGuide).not.toContain("返回：");
    if ([2, 3, 5].includes(requests)) {
      expect(tools.map(tool => tool.function.name)).toContain("send_http");
      expect(tools.find(tool => tool.function.name === "send_http")!.function.parameters).toHaveProperty("properties.url");
    }
    return { finish: "tool_calls", content: "", attempts: 1, parseOk: true, schemaOk: true,
      faultCode: null, missing: [], toolCalls: requests === 1
        ? [{ id: "load", name: "catalog.add", arguments: { names: ["send_http"], reason: "读取接口" } }]
        : [{ id: "done", name: "finishTurn", arguments: { text: "完成", reason: "答复", affectsPage: false} }] };
  } };
  try {
    const result = await handleTurn({ dataDir, repoRoot: join(import.meta.dir, ".."), provider }, { userInput: "检查接口", submittedAt: "now" });
    expect(result.output).toEqual({ kind: "reply", text: "完成" });
    expect(requests).toBe(2);
    const next = await handleTurn({ dataDir, repoRoot: join(import.meta.dir, ".."), provider }, { userInput: "下一轮", submittedAt: "now" });
    expect(next.output).toEqual({ kind: "reply", text: "完成" });
    expect(requests).toBe(3);
    expect(loadLedger(dataDir, result.conversationId).loadedToolIds).toEqual(["send_http"]);
    const fresh = newConversation(dataDir);
    expect(loadLedger(dataDir, fresh.conversationId!).loadedToolIds).toEqual([]);
    expect((await handleTurn({ dataDir, repoRoot: join(import.meta.dir, ".."), provider }, { userInput: "新会话", submittedAt: "now" })).output).toEqual({ kind: "reply", text: "完成" });
    expect(requests).toBe(4);
    openConversation(dataDir, result.conversationId);
    expect((await handleTurn({ dataDir, repoRoot: join(import.meta.dir, ".."), provider }, { userInput: "重新打开", submittedAt: "now" })).output).toEqual({ kind: "reply", text: "完成" });
    expect(requests).toBe(5);
    expect(loadLedger(dataDir, result.conversationId).toolIO.filter(row => row.name === "catalog.add")).toHaveLength(1);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
