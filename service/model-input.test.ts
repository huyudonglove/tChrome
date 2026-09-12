import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleTurn } from "./runtime/loop.ts";
import type { Provider } from "./types.ts";
import { coreToolIds, loadToolRegistry } from "./tools/registry.ts";

test("resident and dynamic guides remain separate, update on loading and reset on the next turn", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-model-input-"));
  const registry = loadToolRegistry(join(import.meta.dir, ".."));
  let requests = 0;
  let initialSystem = "";
  const provider: Provider = { complete: async ({ messages, tools }) => {
    requests++;
    const system = messages[0]!.content;
    const user = messages[1]!.content;
    const baseGuide = system.split("#baseTools --")[1]!.split("# User 栏目清单")[0]!;
    const dynamicGuide = user.split("#tools\n\n")[1]!;
    const names = (guide: string) => [...guide.matchAll(/^- ([^：]+)：/gm)].map(match => match[1]);
    expect(names(baseGuide)).toEqual(registry.toolGroups.baseToolsIds);
    expect(names(dynamicGuide)).toEqual([...coreToolIds(registry), ...(requests === 2 ? ["send_http"] : [])]);
    expect(user).not.toContain("#baseTools");
    if (requests === 1) initialSystem = system;
    else expect(system).toBe(initialSystem);
    for (const tool of tools) {
      expect(tool.function.description?.length ?? 0).toBeGreaterThan(0);
    }
    expect(baseGuide).not.toContain("参数：");
    expect(dynamicGuide).not.toContain("返回：");
    if (requests === 2) {
      expect(tools.map(tool => tool.function.name)).toContain("send_http");
      expect(tools.find(tool => tool.function.name === "send_http")!.function.parameters).toHaveProperty("properties.url");
    }
    return { finish: "tool_calls", content: "", attempts: 1, parseOk: true, schemaOk: true,
      faultCode: null, missing: [], toolCalls: requests === 1
        ? [{ id: "load", name: "catalog.add", arguments: { names: ["send_http"], reason: "读取接口" } }]
        : [{ id: "done", name: "finishTurn", arguments: { text: "完成", reason: "答复", affectsPage: false } }] };
  } };
  try {
    const result = await handleTurn({ dataDir, repoRoot: join(import.meta.dir, ".."), provider }, { userInput: "检查接口", submittedAt: "now" });
    expect(result.output).toEqual({ kind: "reply", text: "完成" });
    expect(requests).toBe(2);
    const next = await handleTurn({ dataDir, repoRoot: join(import.meta.dir, ".."), provider }, { userInput: "下一轮", submittedAt: "now" });
    expect(next.output).toEqual({ kind: "reply", text: "完成" });
    expect(requests).toBe(3);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
