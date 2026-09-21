import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type SkillManifest = { enabled: string[] };
export type SkillDocument = { id: string; body: string; description: string };

export function loadSkillManifest(repoRoot: string): SkillManifest {
  const raw = JSON.parse(readFileSync(join(repoRoot, "service/skills/index.json"), "utf8"));
  if (!Array.isArray(raw)) throw new Error("invalid skill index");
  const enabled: string[] = [];
  for (const id of raw) {
    if (typeof id !== "string" || !id || id.includes("..") || id.includes("/") || id.includes("\\") || enabled.includes(id)) {
      throw new Error("invalid skill index");
    }
    enabled.push(id);
  }
  return { enabled };
}

export function enabledSkillIds(repoRoot: string): string[] {
  return loadSkillManifest(repoRoot).enabled;
}

export function listSkills(repoRoot: string): { id: string }[] {
  const dir = join(repoRoot, "service/skills");
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({ id: entry.name }))
    .filter(item => {
      try { readSkill(repoRoot, item.id); return true; }
      catch { return false; }
    });
}

export function readSkill(repoRoot: string, id: string): SkillDocument & { tags: string[] } {
  if (!id || id.includes("..") || id.includes("/") || id.includes("\\")) throw new Error("invalid skill id");
  const path = join(repoRoot, "service/skills", id, "SKILL.md");
  const body = readFileSync(path, "utf8").trim();
  if (!body) throw new Error(`empty skill ${id}`);
  const lines = body.split(/\r?\n/);
  const description = lines[0]!.replace(/^#+\s*/, "").trim() || id;
  let tags: string[] = [];
  for (const line of lines.slice(0, 8)) {
    const match = line.match(/^TAGS[:：]\s*(.+)$/i);
    if (!match) continue;
    tags = match[1]!.split(/[,，、\s]+/).map(part => part.trim()).filter(Boolean);
    break;
  }
  return { id, body, description, tags };
}

export function loadSkills(repoRoot: string): string {
  return enabledSkillIds(repoRoot)
    .map(id => readSkill(repoRoot, id).body)
    .filter(Boolean)
    .join("\n\n");
}

export function skillCatalog(repoRoot: string, tag?: string): { id: string; tags: string[]; purpose: string }[] {
  const ids = [...enabledSkillIds(repoRoot)];
  for (const item of listSkills(repoRoot)) {
    if (!ids.includes(item.id)) ids.push(item.id);
  }
  const items = ids.map(id => {
    const skill = readSkill(repoRoot, id);
    const purpose = skill.description.split(/[。\n]/, 1)[0]!.trim() || id;
    return { id: skill.id, tags: skill.tags, purpose };
  });
  if (!tag) return items;
  const want = tag.trim().toLowerCase();
  return items.filter(item => item.tags.some(t => t.toLowerCase() === want));
}

export function skillGuide(repoRoot: string): string {
  return skillCatalog(repoRoot)
    .map(item => `- ${item.id}｜${item.tags.length ? item.tags.join("/") : "—"}｜${item.purpose}。`)
    .join("\n");
}

export function loadedSkillText(repoRoot: string, loadedIds: string[]): string {
  return loadedIds
    .map(id => readSkill(repoRoot, id).body.trim())
    .filter(Boolean)
    .join("\n\n");
}
