import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkillManifest, loadSkills, skillCatalog, skillCatalogPage, skillGuide } from "./loader.ts";

test("resident skills assemble into system guide and only dynamic skills enter catalog", () => {
  const root = mkdtempSync(join(tmpdir(), "tchrome-skills-"));
  const dir = join(root, "service/skills");
  try {
    for (const name of ["first", "second", "third"]) mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, "first/SKILL.md"), "SUMMARY: 浏览器页面观察。\n# 第一技能\nFIRST {{data}}");
    writeFileSync(join(dir, "second/SKILL.md"), "# 第二技能\nSECOND");
    writeFileSync(join(dir, "third/SKILL.md"), "SUMMARY: 侧栏回复格式。\n# 第三技能\nTHIRD");
    writeFileSync(join(dir, "index.json"), JSON.stringify({
      residentSkillIds: ["second"],
      dynamicSkillIds: ["first", "third"],
    }));
    expect(loadSkillManifest(root)).toEqual({
      residentSkillIds: ["second"],
      dynamicSkillIds: ["first", "third"],
    });
    expect(loadSkills(root)).toBe("SUMMARY: 浏览器页面观察。\n# 第一技能\nFIRST {{data}}\n\nSUMMARY: 侧栏回复格式。\n# 第三技能\nTHIRD");
    const catalog = skillCatalog(root);
    expect(catalog).toEqual([
      { id: "first", summary: "浏览器页面观察。", purpose: "第一技能" },
      { id: "third", summary: "侧栏回复格式。", purpose: "第三技能" },
    ]);
    expect(skillCatalog(root, "浏览器").map(item => item.id)).toEqual(["first"]);
    expect(skillCatalog(root, "侧栏").map(item => item.id)).toEqual(["third"]);
    expect(skillCatalog(root, "FIRST").map(item => item.id)).toEqual(["first"]);
    const guide = skillGuide(root);
    expect(guide).toContain("### 常驻技能");
    expect(guide).toContain("SECOND");
    expect(guide).toContain("- first｜浏览器页面观察。");
    expect(guide).toContain("- third｜侧栏回复格式。");
    expect(guide).not.toContain("- second｜");
    expect(skillCatalogPage(root)).toEqual({
      skills: [
        { id: "first", summary: "浏览器页面观察。", purpose: "第一技能" },
        { id: "third", summary: "侧栏回复格式。", purpose: "第三技能" },
      ],
      total: 2,
      offset: 0,
      limit: null,
      hasMore: false,
    });
    // keyword 只匹配 id + summary，不匹配 purpose
    expect(skillCatalogPage(root, { keyword: "第一" }).skills).toEqual([]);
    expect(skillCatalogPage(root, { keyword: "浏览器" }).skills).toEqual([
      { id: "first", summary: "浏览器页面观察。", purpose: "第一技能" },
    ]);
    expect(skillCatalogPage(root, { limit: 1 })).toMatchObject({ total: 2, offset: 0, limit: 1, hasMore: true });
    expect(skillCatalogPage(root, { offset: 1, limit: 1 }).skills.map(item => item.id)).toEqual(["third"]);
    expect(skillCatalogPage(root, { offset: 9 }).skills).toEqual([]);
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
