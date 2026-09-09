import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ContextModules = {
  systemInventory: string;
  userInventory: string;
  systemSlots: Record<string, string>;
  userSlots: Record<string, string>;
  skill: string;
};

const loadSlots = (contextModules: string, role: string): Record<string, string> =>
  Object.fromEntries(readdirSync(join(contextModules, role))
    .filter((file) => file.endsWith(".md"))
    .map((file) => [`#${file.slice(0, -3)}`, readFileSync(join(contextModules, role, file), "utf8").trimEnd()]));

export function renderSlots(inventory: string, files: Record<string, string>, data: Record<string, string>): string {
  return slotNames(inventory).map((name) => {
    const file = files[name];
    if (!file) throw new Error(`missing slot file ${name}`);
    return interpolate(file, { data: data[name] ?? "" });
  }).join("\n\n");
}

export function loadContextModules(root: string): ContextModules {
  const contextModules = join(root, "service", "context");
  const systemSlots = loadSlots(contextModules, "system");
  const userSlots = loadSlots(contextModules, "user");
  const skill = readFileSync(join(contextModules, "skills", "skill.web.md"), "utf8").replace(/^#skill\n?/, "").trim();
  const systemInventory = readFileSync(join(contextModules, "system-slots.md"), "utf8").trimEnd();
  const userInventory = readFileSync(join(contextModules, "user-slots.md"), "utf8").trimEnd();
  for (const [inventory, files] of [[systemInventory, systemSlots], [userInventory, userSlots]] as const) {
    const names = slotNames(inventory);
    for (const name of names) if (!files[name]) throw new Error(`missing slot file ${name}`);
    for (const name of Object.keys(files)) if (!names.includes(name)) throw new Error(`unlisted slot file ${name}`);
  }
  return { systemInventory, userInventory, systemSlots, userSlots, skill };
}

export function interpolate(template: string, slots: Record<string, string>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, name: string) => slots[name.trim()] ?? "");
}

/** Read numbered Markdown inventory rows; no second ordering template. */
export function slotNames(inventory: string): string[] {
  const rows = inventory.split(/\r?\n/).filter(line => /^\|\s*\d+\s*\|/.test(line));
  if (!rows.length) throw new Error("empty slot inventory");
  const names: string[] = [];
  for (const [index, row] of rows.entries()) {
    const cells = row.split("|").slice(1, -1).map(cell => cell.trim());
    const identifiers = cells.filter(cell => /^`#[A-Za-z][A-Za-z0-9]*`$/.test(cell));
    if (Number(cells[0]) !== index + 1 || identifiers.length !== 1) throw new Error(`invalid slot inventory row ${row}`);
    const name = identifiers[0]!.slice(1, -1);
    if (names.includes(name)) throw new Error(`duplicate slot ${name}`);
    names.push(name);
  }
  return names;
}
