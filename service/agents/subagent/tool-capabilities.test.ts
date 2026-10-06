import { expect, test } from "bun:test";
import { SUBAGENT_TOOL_CAPABILITIES } from "./tool-capabilities.ts";
import { ROLE_PERMISSIONS, type SubagentRole } from "./types.ts";

const LABELS = new Set(["read", "write", "test", "browser"]);

/** 与 executor.toolNamesFor 相同的规则：标签非空且全部落在角色上限内才暴露。 */
const exposedTo = (role: SubagentRole, tool: string): boolean => {
  const capabilities = SUBAGENT_TOOL_CAPABILITIES[tool] ?? [];
  const permissions = new Set<string>(ROLE_PERMISSIONS[role]);
  return capabilities.length > 0 && capabilities.every((capability) => permissions.has(capability));
};

test("每个能力标签都是角色上限里的四种之一，且不为空", () => {
  for (const [tool, capabilities] of Object.entries(SUBAGENT_TOOL_CAPABILITIES)) {
    expect(capabilities.length, `${tool} 必须至少带一个能力标签`).toBeGreaterThan(0);
    for (const capability of capabilities) {
      expect(LABELS.has(capability), `${tool} 的标签 ${capability}`).toBe(true);
    }
  }
});

test("研究角色拿到只读工具，拿不到写入与浏览器工具", () => {
  expect(exposedTo("researcher", "local_fs_read")).toBe(true);
  expect(exposedTo("researcher", "evidence_search")).toBe(true);
  expect(exposedTo("researcher", "local_fs_write")).toBe(false);
  expect(exposedTo("researcher", "local_apply_patch")).toBe(false);
  expect(exposedTo("researcher", "page_get_summary")).toBe(false);
});

test("实现角色能写能跑测试，浏览器工具只给复现角色", () => {
  expect(exposedTo("implementer", "local_apply_patch")).toBe(true);
  expect(exposedTo("implementer", "local_run")).toBe(true);
  expect(exposedTo("implementer", "page_click_role")).toBe(false);
  expect(exposedTo("reproducer", "page_click_role")).toBe(true);
  expect(exposedTo("reproducer", "local_fs_write")).toBe(false);
});

test("没有对任何人都不可达的死条目", () => {
  const roles = Object.keys(ROLE_PERMISSIONS) as SubagentRole[];
  const dead = Object.keys(SUBAGENT_TOOL_CAPABILITIES).filter((tool) => !roles.some((role) => exposedTo(role, tool)));
  expect(dead).toEqual([]);
});
