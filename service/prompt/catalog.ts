import { readFileSync } from "node:fs";
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

export const DYNAMIC_TOOLS_IDS = [
  "page.current",
  "page.read",
  "page.open",
  "web.search",
] as const;

export type Catalog = {
  pack: Record<string, string>;
  skill: string;
  sop: string;
  tools: Record<string, ChatTool>;
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
  const tools: Record<string, ChatTool> = {};
  for (const id of [...BASE_TOOLS_IDS, ...DYNAMIC_TOOLS_IDS]) {
    tools[id] = JSON.parse(readFileSync(join(catalog, "tools", `${id}.json`), "utf8")) as ChatTool;
  }
  return { pack, skill, sop, tools };
}

export function toolSchemas(catalog: Catalog, ids: string[]): ChatTool[] {
  return ids.map((id) => {
    const tool = catalog.tools[id];
    if (!tool) throw new Error(`unknown tool ${id}`);
    return tool;
  });
}
