import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatTool } from "../types.ts";

export type ToolIndex = {
  browser: string[];
  service: string[];
  affectsPage: Record<string, boolean>;
  usage: Record<string, string>;
};

export type Assemble = {
  systemIds: string[];
  skillIds: string[];
  baseToolsIds: string[];
  coreToolIds: string[];
  messages: {
    emptyFinishTurn: string;
    needFinishTurn: string;
  };
};

export type Catalog = {
  pack: Record<string, string>;
  skill: string;
  tools: Record<string, ChatTool>;
  index: ToolIndex;
  assemble: Assemble;
  systemTemplate: string;
  userTemplate: string;
};

const splitHeadings = (text: string): Record<string, string> => {
  const sections: Record<string, string> = {};
  let current = "";
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  for (const line of lines) {
    if (line.startsWith("#") && !line.startsWith("##")) {
      current = line.trim();
      sections[current] = "";
      continue;
    }
    if (!current) continue;
    sections[current] = sections[current] ? `${sections[current]}\n${line}` : line;
  }
  for (const key of Object.keys(sections)) {
    sections[key] = (sections[key] ?? "").trimEnd();
  }
  return sections;
};

export function loadCatalog(root: string): Catalog {
  const catalog = join(root, "catalog");
  const pack = splitHeadings(readFileSync(join(catalog, "packs", "pack.agent.md"), "utf8"));
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
  return { pack, skill, tools, index, assemble, systemTemplate, userTemplate };
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
      const line = catalog.index.usage[id];
      if (!line) return "";
      const affects = catalog.index.affectsPage[id] ? "true" : "false";
      return `${id}：${line} affectsPage=${affects}。`;
    })
    .filter(Boolean)
    .join("\n");
}

export function interpolate(template: string, slots: Record<string, string>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, name: string) => slots[name.trim()] ?? "");
}

export function slotNames(template: string): string[] {
  const names: string[] = [];
  for (const line of template.split("\n")) {
    if (line.startsWith("#") && !line.startsWith("##") && !line.startsWith("{{")) names.push(line.trim());
  }
  return names;
}
