import { expect, test } from "bun:test";
import { join } from "node:path";
import { coreToolIds, dynamicToolIds, loadToolRegistry, zeroCallToolNote } from "../tools/registry.ts";

const repoRoot = join(import.meta.dir, "../..");
const registry = loadToolRegistry(repoRoot);

// 回归：这条提醒的用途是判断「本会话加载的动态工具到底调用过没有」，所以数据源必须是完整
// 调用记录。视图账本（contextState 返回的 ledger.toolIO）会剔掉被压缩归档覆盖的行，用它
// 统计就会把「在已归档轮次里调用过」的工具误报成零调用。
test("已归档轮次里的调用仍算已调用，不因视图裁剪被报成零调用", () => {
  const tool = dynamicToolIds(registry).find((id) => !coreToolIds(registry).includes(id))!;
  const trimmedView = [{ name: "local_fs_read" }];
  const fullCalls = [{ name: tool }, { name: "local_fs_read" }];
  expect(zeroCallToolNote(registry, [tool], trimmedView)).toContain(tool);
  expect(zeroCallToolNote(registry, [tool], fullCalls)).toBe("");
});
