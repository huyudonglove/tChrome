import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { coreToolIds, dynamicToolIds, loadToolRegistry, zeroCallToolNote } from "../tools/registry.ts";

const repoRoot = join(import.meta.dir, "../..");
const registry = loadToolRegistry(repoRoot);
const loopSource = readFileSync(join(import.meta.dir, "loop.ts"), "utf8");

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

test("loop 的零调用提醒取自完整账本，不取被压缩裁剪的视图账本", () => {
  expect(loopSource).toContain("zeroCallToolNote(toolRegistry, ledger.loadedToolIds, allCalls)");
  expect(loopSource).not.toContain("zeroCallToolNote(toolRegistry, ledger.loadedToolIds, ledger.toolIO)");
  // 同一类「会话级判断」也不能读视图账本：活跃项目作用域决定注入哪些项目记忆，
  // 从视图里推导会在归档后悄悄漏掉项目记忆。
  expect(loopSource).toContain("deriveActiveScopes(allCalls)");
  // 5 处运行期装配都必须显式传入完整账本；漏传会静默回退到已被裁剪的视图账本。
  expect(loopSource.match(/setNotice, ledger\.toolIO\)/g) ?? []).toHaveLength(5);
});
