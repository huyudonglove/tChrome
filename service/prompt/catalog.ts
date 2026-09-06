import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatTool } from "../types.ts";

export const SYSTEM_SLOTS = [
  "#身份",
  "#记忆",
  "#观察",
  "#环境",
  "#原则",
  "#参数说明",
  "#内置工具",
  "#输出",
  "#user字段说明",
  "#skill",
  "#sop",
] as const;

export const USER_SLOTS = [
  "#projectMemory",
  "#conversationMemory",
  "#turnMemory",
  "#contextSummary",
  "#observation",
  "#userInputHistory",
  "#userInput",
  "#currentEnvironment",
  "#toolIO",
  "#tools",
] as const;

export const BASE_TOOLS_IDS = [
  "askUser",
  "finishTurn",
  "tool.detail",
  "observation.detail",
  "memory.write",
] as const;

export type ToolIndex = {
  browser: string[];
  service: string[];
  affectsPage: Record<string, boolean>;
  usage: Record<string, string>;
};

export type Catalog = {
  pack: Record<string, string>;
  skill: string;
  sop: string;
  tools: Record<string, ChatTool>;
  index: ToolIndex;
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
  const sop = readFileSync(join(catalog, "sops", "sop.browse.md"), "utf8").replace(/^#sop\n?/, "").trim();
  const index = JSON.parse(readFileSync(join(catalog, "tools", "index.json"), "utf8")) as ToolIndex;
  const tools: Record<string, ChatTool> = {};
  for (const file of readdirSync(join(catalog, "tools"))) {
    if (!file.endsWith(".json") || file === "index.json") continue;
    const tool = JSON.parse(readFileSync(join(catalog, "tools", file), "utf8")) as ChatTool;
    const name = tool.function?.name;
    if (name) tools[name] = tool;
  }
  return { pack, skill, sop, tools, index };
}

export function dynamicToolIds(catalog: Catalog): string[] {
  return [...catalog.index.browser, ...catalog.index.service];
}

export function toolSchemas(catalog: Catalog, ids: string[]): ChatTool[] {
  return ids.map((id) => {
    const tool = catalog.tools[id];
    if (!tool) throw new Error(`unknown tool ${id}`);
    return tool;
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
