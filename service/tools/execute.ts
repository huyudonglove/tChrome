import type { ToolArguments, ToolIOItem, ToolReturn } from "../types.ts";

export const WINDOW_TEXT_LIMIT = 2000;

export function clipReturn(full: string): ToolReturn {
  const totalChars = full.length;
  if (totalChars <= WINDOW_TEXT_LIMIT) {
    return { stage: "complete", totalChars, text: full };
  }
  return { stage: "truncated", totalChars, text: full.slice(0, WINDOW_TEXT_LIMIT) };
}

export function actionFromContent(content: string): string {
  const match = content.match(/(?:^|\n)action\n([\s\S]*)$/i);
  return (match?.[1] ?? content).trim();
}

export function questionFromContent(content: string, choice: string[]): string {
  const action = actionFromContent(content);
  if (choice.length === 0) return action;
  return `${action}\n选项：${choice.join(" / ")}`;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function toolUsageFor(ids: string[]): string {
  const usage: Record<string, string> = {
    "web.search": "web.search：检索网页。query 是检索词。",
  };
  return ids.map((id) => usage[id] ?? "").filter(Boolean).join("\n");
}

export type ExecuteInput = {
  name: string;
  arguments: ToolArguments;
  content: string;
  lookup: {
    toolIO: ToolIOItem[];
    fullReturn: (callId: string) => string | null;
    observationFull: (observationId: string) => string | null;
  };
};

export function executeTool(input: ExecuteInput): string {
  const { name, arguments: args, content, lookup } = input;
  if (name === "finishTurn") return actionFromContent(content);
  if (name === "askUser") return questionFromContent(content, asStringArray(args.choice));
  if (name === "memory.write") {
    const turn = asStringArray(args.turnMemory).length;
    const conversation = asStringArray(args.conversationMemory).length;
    const project = asStringArray(args.projectMemory).length;
    return `落下 turn=${turn} conversation=${conversation} project=${project}`;
  }
  if (name === "tool.detail") {
    const callId = String(args.callId ?? "");
    const full = lookup.fullReturn(callId);
    if (full !== null) return full;
    const item = lookup.toolIO.find((row) => row.callId === callId);
    return item?.return.text ?? `没有 ${callId} 的全文`;
  }
  if (name === "observation.detail") {
    const observationId = String(args.observationId ?? "");
    return lookup.observationFull(observationId) ?? `没有 ${observationId}`;
  }
  if (name === "web.search") {
    return `web.search 第一期未接检索源。query=${String(args.query ?? "")}`;
  }
  return `${name} 第一期未接`;
}
