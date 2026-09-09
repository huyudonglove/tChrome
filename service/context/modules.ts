import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatTool } from "../types.ts";

export type ToolIndex = {
  browser: string[];
  service: string[];
};

export type ToolGroups = {
  baseToolsIds: string[];
  coreToolIds: string[];
};

export type ContextModules = {
  systemInventory: string;
  userInventory: string;
  systemSlots: Record<string, string>;
  userSlots: Record<string, string>;
  skill: string;
  tools: Record<string, ChatTool>;
  index: ToolIndex;
  toolGroups: ToolGroups;
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
  const contextModules = join(root, "context");
  const systemSlots = loadSlots(contextModules, "system");
  const userSlots = loadSlots(contextModules, "user");
  const skill = readFileSync(join(contextModules, "skills", "skill.web.md"), "utf8").replace(/^#skill\n?/, "").trim();
  const index = JSON.parse(readFileSync(join(contextModules, "tools", "index.json"), "utf8")) as ToolIndex;
  const toolGroups = JSON.parse(readFileSync(join(contextModules, "tools", "groups.json"), "utf8")) as ToolGroups;
  const tools: Record<string, ChatTool> = {};
  for (const file of readdirSync(join(contextModules, "tools"))) {
    if (!file.endsWith(".json") || ["index.json", "groups.json"].includes(file)) continue;
    const tool = JSON.parse(readFileSync(join(contextModules, "tools", file), "utf8")) as ChatTool;
    const name = tool.function?.name;
    if (name) tools[name] = tool;
  }
  const systemInventory = readFileSync(join(contextModules, "system-slots.md"), "utf8").trimEnd();
  const userInventory = readFileSync(join(contextModules, "user-slots.md"), "utf8").trimEnd();
  for (const [inventory, files] of [[systemInventory, systemSlots], [userInventory, userSlots]] as const) {
    const names = slotNames(inventory);
    for (const name of names) if (!files[name]) throw new Error(`missing slot file ${name}`);
    for (const name of Object.keys(files)) if (!names.includes(name)) throw new Error(`unlisted slot file ${name}`);
  }
  return { systemInventory, userInventory, systemSlots, userSlots, skill, tools, index, toolGroups };
}

export function dynamicToolIds(contextModules: ContextModules): string[] {
  return [...contextModules.index.browser, ...contextModules.index.service];
}

export function coreToolIds(contextModules: ContextModules): string[] {
  return contextModules.toolGroups.coreToolIds.filter((id) => Boolean(contextModules.tools[id]));
}

export function toolSchemas(contextModules: ContextModules, ids: string[]): ChatTool[] {
  return ids.map((id) => {
    const tool = contextModules.tools[id];
    if (!tool) throw new Error(`unknown tool ${id}`);
    const parameters = tool.function.parameters;
    const properties = parameters.properties as Record<string, Record<string, unknown>> | undefined;
    if (!properties?.reason) return tool;
    return {
      ...tool,
      function: {
        ...tool.function,
        parameters: {
          ...parameters,
          properties: {
            ...properties,
            reason: {
              ...properties.reason,
              description: "直接展示给用户的行动理由。用一两句日常语言说明为什么现在要做这一步、它与用户目标的关系；根据已有事实，不编造理由。不要只复述动作，也不要用元素 id、DOM 或工具函数名代替解释。",
            },
          },
        },
      },
    };
  });
}

export function toolUsageFor(contextModules: ContextModules, ids: string[]): string {
  return ids
    .map((id) => {
      const line = contextModules.tools[id]?.function.description;
      if (!line?.trim()) throw new Error(`missing tool description ${id}`);
      return `${id}：${line}`;
    })
    .filter(Boolean)
    .join("\n");
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
