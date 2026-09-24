import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCapabilityCatalog } from "./capability.ts";
import { loadToolRegistry } from "./registry.ts";

function toolDefinition(name: string, description: string) {
  return {
    type: "function" as const,
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: { reason: { type: "string" }, tabId: { type: "integer" } },
        required: ["reason", "tabId"],
      },
    },
  };
}

test("real registry has complete metadata for every tool", () => {
  const registry = loadToolRegistry(join(import.meta.dir, "../.."));
  const toolIds = Object.keys(registry.tools);
  const toolCapabilities = registry.capabilities.filter((item) => item.kind === "tool");
  const skillCapabilities = registry.capabilities.filter((item) => item.kind === "skill");
  expect(toolCapabilities).toHaveLength(toolIds.length);
  expect(skillCapabilities).toHaveLength(10);
  expect(toolCapabilities.every((item) => item.metadataComplete)).toBe(true);
  expect(skillCapabilities.every((item) => item.metadataComplete)).toBe(true);
  expect(toolCapabilities.find((item) => item.id === "account_vault")?.risk).toBe("high");
  expect(toolCapabilities.find((item) => item.id === "page.get_summary")?.risk).toBe("medium");
  expect(skillCapabilities.find((item) => item.id === "code-engineering")?.risk).toBe("medium");
  expect(skillCapabilities.find((item) => item.id === "reply-format")?.risk).toBe("low");
});

test("capability catalog unifies tools and skills with backward-compatible defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "tchrome-capabilities-"));
  const skills = join(root, "service/skills");
  try {
    for (const id of ["resident", "dynamic"]) mkdirSync(join(skills, id), { recursive: true });
    writeFileSync(join(skills, "resident/SKILL.md"), "TAGS:\n- 页面\n# 常驻技能\nBODY");
    writeFileSync(join(skills, "dynamic/SKILL.md"), "TAGS:\n- 诊断\n# 动态技能\nBODY");
    writeFileSync(join(root, "service/skills/index.json"), JSON.stringify({ residentSkillIds: ["resident"], dynamicSkillIds: ["dynamic"] }));

    const catalog = loadCapabilityCatalog(root, {
      tools: {
        page: toolDefinition("page", "查看页面摘要。\n更多说明。"),
        local: toolDefinition("local", "读取本地文件。"),
      },
      index: { browser: ["page"], service: ["local"] },
      toolGroups: { baseToolsIds: ["page"], coreToolIds: ["local"] },
      execution: { page: "parallel", local: "serial" },
    });
    expect(catalog.map(item => item.id)).toEqual(["dynamic", "local", "page", "resident"]);
    expect(catalog.find(item => item.id === "page")).toMatchObject({
      kind: "tool", purpose: "查看页面摘要", triggers: [], risk: "unknown", availability: "base",
      inputs: [{ name: "reason", required: true }, { name: "tabId", required: true }], metadataComplete: false,
    });
    expect(catalog.find(item => item.id === "dynamic")).toMatchObject({
      kind: "skill", purpose: "动态技能", triggers: ["诊断"], availability: "dynamic", source: "service/skills/dynamic/SKILL.md",
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("capability sidecar enriches metadata and rejects unknown or invalid entries", () => {
  const root = mkdtempSync(join(tmpdir(), "tchrome-capabilities-"));
  const skills = join(root, "service/skills");
  const source = {
    tools: { page: toolDefinition("page", "查看页面。") },
    index: { browser: ["page"], service: [] },
    toolGroups: { baseToolsIds: [], coreToolIds: ["page"] },
    execution: { page: "parallel" as const },
  };
  try {
    mkdirSync(join(skills, "skill"), { recursive: true });
    writeFileSync(join(skills, "skill/SKILL.md"), "# 技能\nBODY");
    writeFileSync(join(root, "service/skills/index.json"), JSON.stringify({ residentSkillIds: [], dynamicSkillIds: ["skill"] }));
    mkdirSync(join(root, "service/capabilities"), { recursive: true });
    writeFileSync(join(root, "service/capabilities/metadata.json"), JSON.stringify({ version: 1, tools: { page: { purpose: "读取页面状态", triggers: ["页面诊断"], risk: "low", verification: ["页面摘要匹配"] } } }));
    const page = loadCapabilityCatalog(root, source).find(item => item.id === "page");
    expect(page).toMatchObject({ purpose: "读取页面状态", triggers: ["页面诊断"], risk: "low", verification: ["页面摘要匹配"], metadataComplete: true });

    writeFileSync(join(root, "service/capabilities/metadata.json"), JSON.stringify({ version: 1, tools: { missing: {} } }));
    expect(() => loadCapabilityCatalog(root, source)).toThrow("unknown tool in capability metadata missing");
    writeFileSync(join(root, "service/capabilities/metadata.json"), JSON.stringify({ version: 1, tools: { page: { triggers: ["ok", 1] } } }));
    expect(() => loadCapabilityCatalog(root, source)).toThrow("invalid capability metadata page.triggers");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
