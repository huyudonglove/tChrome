import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Skill membership/order belongs here; runtime passes the text to context. */
export function loadSkills(root: string): string {
  const dir = join(root, "service", "skills");
  const names: unknown = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
  if (!Array.isArray(names) || names.some(name => typeof name !== "string" || !/^[a-z][a-z0-9-]*$/.test(name))
    || new Set(names).size !== names.length) throw new Error("invalid skill index");
  return names.map(name => {
    const body = readFileSync(join(dir, name, "SKILL.md"), "utf8").trim();
    if (!body) throw new Error(`empty skill ${name}`);
    return body;
  }).join("\n\n");
}
