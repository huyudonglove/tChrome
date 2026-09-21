import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkillManifest, loadSkills, skillCatalog, skillGuide } from "./loader.ts";

test("resident skills assemble into system guide and only dynamic skills enter catalog", () => {
  const root = mkdtempSync(join(tmpdir(), "tchrome-skills-"));
  const dir = join(root, "service/skills");
  try {
    for (const name of ["first", "second", "third"]) mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, "first/SKILL.md"), "TAGS:\n- 浏览器\n- 页面\n# 第一技能\nFIRST {{data}}");
    writeFileSync(join(dir, "second/SKILL.md"), "TAGS:\n- 宿主\n# 第二技能\nSECOND");
    writeFileSync(join(dir, "third/SKILL.md"), "TAGS:\n- 侧栏\n# 第三技能\nTHIRD");
    writeFileSync(join(dir, "index.json"), JSON.stringify({
      residentSkillIds: ["second"],
      dynamicSkillIds: ["first", "third"],
    }));
    expect(loadSkillManifest(root)).toEqual({
      residentSkillIds: ["second"],
      dynamicSkillIds: ["first", "third"],
    });
    expect(loadSkills(root)).toBe("TAGS:\n- 浏览器\n- 页面\n# 第一技能\nFIRST {{data}}\n\nTAGS:\n- 侧栏\n# 第三技能\nTHIRD");
    const catalog = skillCatalog(root);
    expect(catalog).toEqual([
      { id: "first", tags: ["浏览器", "页面"], purpose: "第一技能" },
      { id: "third", tags: ["侧栏"], purpose: "第三技能" },
    ]);
    expect(skillCatalog(root, "浏览器").map(item => item.id)).toEqual(["first"]);
    const guide = skillGuide(root);
    expect(guide).toContain("### 常驻技能");
    expect(guide).toContain("SECOND");
    expect(guide).toContain("- first｜浏览器/页面｜第一技能。");
    expect(guide).toContain("- third｜侧栏｜第三技能。");
    expect(guide).not.toContain("- second｜");
    writeFileSync(join(dir, "index.json"), JSON.stringify({ residentSkillIds: [], dynamicSkillIds: [] }));
    expect(loadSkills(root)).toBe("");
    expect(skillGuide(root)).toBe("### 动态技能清单\n\n—");
    for (const index of [["../escape"], ["first", "first"], [1], {}, { residentSkillIds: ["first"] }, { dynamicSkillIds: ["first"] }, { residentSkillIds: ["first"], dynamicSkillIds: ["first"] }]) {
      writeFileSync(join(dir, "index.json"), JSON.stringify(index));
      expect(() => loadSkillManifest(root)).toThrow("invalid skill index");
    }
    writeFileSync(join(dir, "index.json"), JSON.stringify({ residentSkillIds: [], dynamicSkillIds: ["missing"] }));
    expect(() => loadSkills(root)).toThrow();
    writeFileSync(join(dir, "index.json"), JSON.stringify({ residentSkillIds: ["first"], dynamicSkillIds: [] }));
    writeFileSync(join(dir, "first/SKILL.md"), "  ");
    expect(() => skillGuide(root)).toThrow("empty skill first");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
