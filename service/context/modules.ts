import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { identityRulesText } from "../identity/catalog.ts";

export type ContextModule = { tag: string; capability: string; description?: string; body: string };
export type ContextModules = {
  overview: string;
  systemOrder: string[];
  userOrder: string[];
  systemInventory: string;
  userInventory: string;
  systemSlots: Record<string, ContextModule>;
  userSlots: Record<string, ContextModule>;
};

/** The manifest owns membership/order only; capability words are opaque model navigation. */
export function slotNames(inventory: string): string[] {
  const rows = inventory.replaceAll("\r\n", "\n").split("\n").map(line => line.trim())
    .filter(line => line && !line.startsWith("# "));
  if (!rows.length) throw new Error("empty slot inventory");
  const names: string[] = [];
  for (const [index, row] of rows.entries()) {
    const match = row.match(/^(\d+)\. ([A-Za-z][A-Za-z0-9]*)$/);
    if (!match || Number(match[1]) !== index + 1) throw new Error(`invalid slot inventory row ${row}`);
    const name = `#${match[2]}`;
    if (names.includes(name)) throw new Error(`duplicate slot ${name}`);
    names.push(name);
  }
  return names;
}

export function parseModule(text: string, expectedTag: string): ContextModule {
  const match = text.replaceAll("\r\n", "\n").trim().match(/^(#[A-Za-z][A-Za-z0-9]*)\n能力：([【][^\n【】]+[】])\n\s*详细描述：\n([\s\S]+)$/);
  if (!match) throw new Error(`invalid module format ${expectedTag}`);
  const [, tag, capability, body] = match;
  if (tag !== expectedTag) throw new Error(`module tag mismatch ${expectedTag}: ${tag}`);
  if (!capability!.slice(1, -1).trim() || !body!.trim()) throw new Error(`empty module content ${expectedTag}`);
  const placeholders = body!.match(/\{\{[\s\S]*?\}\}/g) ?? [];
  if (placeholders.some(value => value !== "{{data}}")) throw new Error(`unknown module placeholder ${expectedTag}`);
  if (placeholders.length > 1) throw new Error(`duplicate data placeholder ${expectedTag}`);
  const parts = body!.split(/\n\n内容：\n/);
  if (parts.length > 2) throw new Error(`duplicate module content section ${expectedTag}`);
  if (parts.length === 2) {
    if (!parts[0]!.trim() || !parts[1]!.trim()) throw new Error(`empty module content ${expectedTag}`);
    if (parts[0]!.includes("{{")) throw new Error(`placeholder in module description ${expectedTag}`);
    return { tag: tag!, capability: capability!, description: parts[0]!.trim(), body: parts[1]!.trim() };
  }
  return { tag: tag!, capability: capability!, body: body!.trim() };
}

const loadSlots = (dir: string, role: string, order: string[]) => {
  const files = readdirSync(join(dir, role)).filter(file => file.endsWith(".md"));
  for (const file of files) {
    if (!order.includes(`#${file.slice(0, -3)}`)) throw new Error(`unlisted slot file #${file.slice(0, -3)}`);
  }
  return Object.fromEntries(order.map(tag => {
    const file = `${tag.slice(1)}.md`;
    if (!files.includes(file)) throw new Error(`missing slot file ${tag}`);
    const module = parseModule(readFileSync(join(dir, role, file), "utf8"), tag);
    if (role === "user" && module.description === undefined) throw new Error(`missing user module description/content ${tag}`);
    if (role === "system" && module.description !== undefined) throw new Error(`unexpected system content section ${tag}`);
    return [tag, module];
  }));
};

export function renderSlots(order: string[], files: Record<string, ContextModule>, data: Record<string, string>): string {
  return order.map(tag => {
    const module = files[tag];
    if (!module) throw new Error(`missing slot file ${tag}`);
    return `${module.tag}\n\n${interpolate(module.body, { data: data[tag] ?? "" })}`.trimEnd();
  }).join("\n\n");
}

/** Each module appears once: tag/capability followed directly by its rules or description. */
export function renderInventory(role: "System" | "User", order: string[], modules: Record<string, ContextModule>, data: Record<string, string> = {}): string {
  return `# ${role} 栏目清单\n\n${order.map(tag => {
    const module = modules[tag];
    if (!module) throw new Error(`missing slot file ${tag}`);
    const text = role === "System" ? interpolate(module.body, { data: data[tag] ?? (tag === "#recordIdentity" ? identityRulesText() : "") }) : module.description!;
    return `${tag} --${module.capability}\n${text}`.trimEnd();
  }).join("\n\n")}`;
}

export function loadContextModules(root: string): ContextModules {
  const dir = join(root, "service", "context");
  const overview = readFileSync(join(dir, "overview.md"), "utf8").trim();
  if (!overview) throw new Error("empty context overview");
  const systemOrder = slotNames(readFileSync(join(dir, "system-slots.md"), "utf8"));
  const userOrder = slotNames(readFileSync(join(dir, "user-slots.md"), "utf8"));
  if (systemOrder.some(tag => userOrder.includes(tag))) throw new Error("duplicate tag across system and user");
  const systemSlots = loadSlots(dir, "system", systemOrder);
  const userSlots = loadSlots(dir, "user", userOrder);
  return { overview, systemOrder, userOrder, systemSlots, userSlots,
    systemInventory: renderInventory("System", systemOrder, systemSlots),
    userInventory: renderInventory("User", userOrder, userSlots) };
}

/** Replace once: user-provided placeholder-looking text is literal data. */
export function interpolate(template: string, slots: Record<string, string>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, name: string) => {
    const key = name.trim();
    if (!(key in slots)) throw new Error(`unknown module placeholder ${key}`);
    return slots[key]!;
  });
}
