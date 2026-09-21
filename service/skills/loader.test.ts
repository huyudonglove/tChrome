import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkills, skillCatalog, skillGuide } from "./loader.ts";

test("skills load in manifest order as literal content and empty index disables injection", () => {
  const root = mkdtempSync(join(tmpdir(), "tchrome-skills-"));
  const dir = join(root, "service/skills");
  try {
    for (const name of ["first", "second"]) mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, "first/SKILL.md"), "FIRST {{data}}");
    writeFileSync(join(dir, "second/SKILL.md"), "SECOND");
    writeFileSync(join(dir, "index.json"), JSON.stringify(["second", "first"]));
    expect(loadSkills(root)).toBe("SECOND\n\nFIRST {{data}}");
    writeFileSync(join(dir, "index.json"), "[]");
    expect(loadSkills(root)).toBe("");
    for (const index of [["../escape"], ["first", "first"], [1], {}]) {
      writeFileSync(join(dir, "index.json"), JSON.stringify(index));
      expect(() => loadSkills(root)).toThrow("invalid skill index");
    }
    writeFileSync(join(dir, "index.json"), '["missing"]');
    expect(() => loadSkills(root)).toThrow();
    writeFileSync(join(dir, "index.json"), '["first"]');
    writeFileSync(join(dir, "first/SKILL.md"), "  ");
    expect(() => loadSkills(root)).toThrow("empty skill first");
    writeFileSync(join(dir, "index.json"), JSON.stringify(["second", "first"]));
    writeFileSync(join(dir, "first/SKILL.md"), "# 第一技能\nTAGS: 浏览器, 页面\nFIRST {{data}}");
    writeFileSync(join(dir, "second/SKILL.md"), "# 第二技能\nTAGS：宿主\nSECOND");
    const catalog = skillCatalog(root);
    expect(catalog).toEqual([
      { id: "second", tags: ["宿主"], purpose: "第二技能" },
      { id: "first", tags: ["浏览器", "页面"], purpose: "第一技能" },
    ]);
    expect(skillCatalog(root, "浏览器").map(item => item.id)).toEqual(["first"]);
    expect(skillGuide(root)).toContain("- second｜宿主｜第二技能。");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
