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

export type ToolRegistry = {
  tools: Record<string, ChatTool>;
  index: ToolIndex;
  toolGroups: ToolGroups;
};

export function loadToolRegistry(root: string): ToolRegistry {
  const index = JSON.parse(readFileSync(join(root, "tools", "index.json"), "utf8")) as ToolIndex;
  const toolGroups = JSON.parse(readFileSync(join(root, "tools", "groups.json"), "utf8")) as ToolGroups;
  const tools: Record<string, ChatTool> = {};
  for (const file of readdirSync(join(root, "tools"))) {
    if (!file.endsWith(".json") || ["index.json", "groups.json"].includes(file)) continue;
    const tool = JSON.parse(readFileSync(join(root, "tools", file), "utf8")) as ChatTool;
    const name = tool.function?.name;
    if (name) tools[name] = tool;
  }
  return { tools, index, toolGroups };
}

export function dynamicToolIds(registry: ToolRegistry): string[] {
  return [...registry.index.browser, ...registry.index.service];
}

export function coreToolIds(registry: ToolRegistry): string[] {
  return registry.toolGroups.coreToolIds.filter((id) => Boolean(registry.tools[id]));
}

export function toolSchemas(registry: ToolRegistry, ids: string[]): ChatTool[] {
  return ids.map((id) => {
    const tool = registry.tools[id];
    if (!tool) throw new Error(`unknown tool ${id}`);
    return tool;
  });
}

export function toolUsageFor(registry: ToolRegistry, ids: string[]): string {
  return ids
    .map((id) => {
      const line = registry.tools[id]?.function.description;
      if (!line?.trim()) throw new Error(`missing tool description ${id}`);
      return `${id}：${line}`;
    })
    .filter(Boolean)
    .join("\n");
}

