import { readFileSync } from "node:fs";
import { join } from "node:path";

export type SkillManifest = { residentSkillIds: string[]; dynamicSkillIds: string[] };
export type SkillDocument = { id: string; body: string; description: string };

function readSkillIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error("invalid skill index");
  const ids: string[] = [];
  for (const id of raw) {
    if (typeof id !== "string" || !id || id.includes("..") || id.includes("/") || id.includes("\\") || ids.includes(id)) {
      throw new Error("invalid skill index");
    }
    ids.push(id);
  }
  return ids;
}

export function loadSkillManifest(repoRoot: string): SkillManifest {
  const raw = JSON.parse(readFileSync(join(repoRoot, "service/skills/index.json"), "utf8")) as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid skill index");
  const residentSkillIds = readSkillIdList(raw.residentSkillIds);
  const dynamicSkillIds = readSkillIdList(raw.dynamicSkillIds);
  for (const id of residentSkillIds) {
    if (dynamicSkillIds.includes(id)) throw new Error("invalid skill index");
  }
  return { residentSkillIds, dynamicSkillIds };
}

export function readSkill(repoRoot: string, id: string): SkillDocument & { summary: string } {
  if (!id || id.includes("..") || id.includes("/") || id.includes("\\")) throw new Error("invalid skill id");
  const path = join(repoRoot, "service/skills", id, "SKILL.md");
  const body = readFileSync(path, "utf8").trim();
  if (!body) throw new Error(`empty skill ${id}`);
  const lines = body.split(/\r?\n/);
  const title = lines.map(line => line.trim()).find(line => line.startsWith("#"))?.replace(/^#+\s*/, "").trim() || id;
  // 摘要在正文最外层：SUMMARY: 一句话，写在 # 标题之前；缺省回退标题。
  let summary = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#")) break;
    const head = line.match(/^SUMMARY[:：]\s*(.+)$/i);
    if (head) {
      summary = head[1]!.trim();
      break;
    }
  }
  return { id, body, description: title, summary: summary || title };
}

function skillInfo(repoRoot: string, id: string): { summary: string; purpose: string } {
  const skill = readSkill(repoRoot, id);
  const purpose = skill.description.split(/[。\n]/, 1)[0]!.trim() || id;
  return { summary: skill.summary, purpose };
}

/** 常驻技能正文装配进 System <systemSkill>；动态技能只出现在 skill.list 与已加载的 User <skill>。 */
export function skillCatalog(repoRoot: string, keyword?: string): { id: string; summary: string; purpose: string }[] {
  const items = loadSkillManifest(repoRoot).dynamicSkillIds.map(id => ({
    id,
    ...skillInfo(repoRoot, id),
  }));
  const want = keyword?.trim().toLowerCase();
  if (!want) return items;
  return items.filter(item => `${item.id} ${item.summary}`.toLowerCase().includes(want));
}

export function skillGuide(repoRoot: string): string {
  const { residentSkillIds, dynamicSkillIds } = loadSkillManifest(repoRoot);
  const parts: string[] = [];
  if (residentSkillIds.length) {
    parts.push("### 常驻技能", "");
    parts.push(...residentSkillIds.map(id => readSkill(repoRoot, id).body.trim()));
    parts.push("");
  }
  parts.push("### 动态技能清单", "");
  if (!dynamicSkillIds.length) parts.push("—");
  else {
    for (const id of dynamicSkillIds) {
      const { summary } = skillInfo(repoRoot, id);
      parts.push(`- ${id}｜${summary}`);
    }
  }
  return parts.join("\n");
}

/** 示例与装配用：动态技能正文；常驻正文不进 User <skill>。 */
export function loadSkills(repoRoot: string): string {
  return loadSkillManifest(repoRoot).dynamicSkillIds
    .map(id => readSkill(repoRoot, id).body)
    .filter(Boolean)
    .join("\n\n");
}

export function loadedSkillText(repoRoot: string, loadedIds: string[]): string {
  return loadedIds
    .map(id => readSkill(repoRoot, id).body.trim())
    .filter(Boolean)
    .join("\n\n");
}
