import { expect, test } from "bun:test";
import { join } from "node:path";
import { coreToolIds, dynamicToolIds, loadToolRegistry, toolSchemas } from "../../tools/registry.ts";
import { SUBAGENT_TOOL_CAPABILITIES } from "./tool-capabilities.ts";

// 口径与 service/runtime/loop.ts 组装 subagentTools 时一致：
// baseToolsIds ∪ coreToolIds() ∪ dynamicToolIds()（会话加载的 toolIds 是 dynamicToolIds 的子集）。
const registry = loadToolRegistry(join(import.meta.dir, "../../.."));
const CANDIDATE_IDS = [...new Set([
  ...registry.toolGroups.baseToolsIds,
  ...coreToolIds(registry),
  ...dynamicToolIds(registry),
])];

test("能力表没有失效条目：每个登记的工具在真实 registry 中都存在", () => {
  const stale = Object.keys(SUBAGENT_TOOL_CAPABILITIES).filter((id) => !registry.tools[id]);
  expect(stale).toEqual([]);
});

test("subagent 装配用的候选 id 集全部有 schema，toolSchemas 不抛错", () => {
  const schemas = toolSchemas(registry, CANDIDATE_IDS);
  expect(schemas.length).toBe(CANDIDATE_IDS.length);
  expect(CANDIDATE_IDS.length).toBeGreaterThan(0);
});
