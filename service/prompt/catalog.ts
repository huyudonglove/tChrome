import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatTool } from "../types.ts";

export type ToolIndex = {
  browser: string[];
  service: string[];
};

export type Assemble = {
  baseToolsIds: string[];
  coreToolIds: string[];
  messages: {
    emptyFinishTurn: string;
    needFinishTurn: string;
  };
};

export type Catalog = {
  systemInventory: string;
  userInventory: string;
  systemSlots: Record<string, string>;
  userSlots: Record<string, string>;
  skill: string;
  tools: Record<string, ChatTool>;
  index: ToolIndex;
  assemble: Assemble;
  systemTemplate: string;
  userTemplate: string;
};

const loadSlots = (catalog: string, role: string): Record<string, string> =>
  Object.fromEntries(readdirSync(join(catalog, "slots", role))
    .filter((file) => file.endsWith(".md"))
    .map((file) => [`#${file.slice(0, -3)}`, readFileSync(join(catalog, "slots", role, file), "utf8").trimEnd()]));

export function renderSlots(template: string, files: Record<string, string>, data: Record<string, string>): string {
  return interpolate(template, Object.fromEntries(slotNames(template).map((name) => {
    const file = files[name];
    if (!file) throw new Error(`missing slot file ${name}`);
    return [name, interpolate(file, { data: data[name] ?? "" })];
  })));
}

export function loadCatalog(root: string): Catalog {
  const catalog = join(root, "catalog");
  const systemSlots = loadSlots(catalog, "system");
  const userSlots = loadSlots(catalog, "user");
  const skill = readFileSync(join(catalog, "skills", "skill.web.md"), "utf8").replace(/^#skill\n?/, "").trim();
  const index = JSON.parse(readFileSync(join(catalog, "tools", "index.json"), "utf8")) as ToolIndex;
  const assemble = JSON.parse(readFileSync(join(catalog, "assemble.json"), "utf8")) as Assemble;
  const systemTemplate = readFileSync(join(catalog, "window.system.md"), "utf8").replaceAll("\r\n", "\n").trimEnd();
  const userTemplate = readFileSync(join(catalog, "window.user.md"), "utf8").replaceAll("\r\n", "\n").trimEnd();
  const tools: Record<string, ChatTool> = {};
  for (const file of readdirSync(join(catalog, "tools"))) {
    if (!file.endsWith(".json") || file === "index.json") continue;
    const tool = JSON.parse(readFileSync(join(catalog, "tools", file), "utf8")) as ChatTool;
    const name = tool.function?.name;
    if (name) tools[name] = tool;
  }
  const systemInventory = readFileSync(join(catalog, "system-slots.md"), "utf8").trimEnd();
  const userInventory = readFileSync(join(catalog, "user-slots.md"), "utf8").trimEnd();
  return { systemInventory, userInventory, systemSlots, userSlots, skill, tools, index, assemble, systemTemplate, userTemplate };
}

export function dynamicToolIds(catalog: Catalog): string[] {
  return [...catalog.index.browser, ...catalog.index.service];
}

export function coreToolIds(catalog: Catalog): string[] {
  return catalog.assemble.coreToolIds.filter((id) => Boolean(catalog.tools[id]));
}

export function toolSchemas(catalog: Catalog, ids: string[]): ChatTool[] {
  return ids.map((id) => {
    const tool = catalog.tools[id];
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

export function toolUsageFor(catalog: Catalog, ids: string[]): string {
  return ids
    .map((id) => {
      const line = catalog.tools[id]?.function.description;
      if (!line?.trim()) throw new Error(`missing tool description ${id}`);
      return `${id}：${line}`;
    })
    .filter(Boolean)
    .join("\n");
}

export function interpolate(template: string, slots: Record<string, string>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, name: string) => slots[name.trim()] ?? "");
}

export function slotNames(template: string): string[] {
  return Array.from(template.matchAll(/\{\{(#[^}\s]+)\}\}/g), (match) => match[1]!);
}
