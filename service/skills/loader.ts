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

export function readSkill(repoRoot: string, id: string): SkillDocument {
  if (!id || id.includes("..") || id.includes("/") || id.includes("\\")) throw new Error("invalid skill id");
  const path = join(repoRoot, "service/skills", id, "SKILL.md");
  const body = readFileSync(path, "utf8").trim();
  if (!body) throw new Error(`empty skill ${id}`);
  const description = body.split(/\n/, 1)[0]!.replace(/^#+\s*/, "").trim();
  return { id, body, description: description || id };
}

export function loadSkills(repoRoot: string): string {
  return enabledSkillIds(repoRoot)
    .map(id => readSkill(repoRoot, id).body)
    .filter(Boolean)
    .join("\n\n");
}

export function skillCatalog(repoRoot: string): { id: string; purpose: string }[] {
  return listSkills(repoRoot).map(item => {
    const body = readSkill(repoRoot, item.id);
    const first = body.description.split(/[。\n]/, 1)[0]!.trim();
    return { id: item.id, purpose: first || item.id };
  });
}

export function skillGuide(repoRoot: string): string {
  return skillCatalog(repoRoot).map(item => `- ${item.id}：${item.purpose}。`).join("\n");
}

export function loadedSkillText(repoRoot: string, loadedIds: string[]): string {
  return loadedIds
    .map(id => readSkill(repoRoot, id).body.trim())
    .filter(Boolean)
    .join("\n\n");
}
