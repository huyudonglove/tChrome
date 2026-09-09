import type { Ledger, MemoryRecord, Turn } from "../types.ts";
import { renderSlots, type ContextModules } from "./modules.ts";

export const MEMORY_WINDOW = 8;

const jsonBody = (value: unknown) => JSON.stringify(value, null, 2);

export function systemText(contextModules: ContextModules, baseToolUsage: string): string {
  return [contextModules.systemInventory, contextModules.userInventory, renderSlots(contextModules.systemInventory, contextModules.systemSlots, {
    "#baseTools": baseToolUsage,
  })].join("\n\n");
}

const memoryBody = (items: MemoryRecord[], compact = false) =>
  items
    .slice(-MEMORY_WINDOW)
    .map((item) => (compact ? (item.summary || item.text.replace(/\s+/g, " ").trim().slice(0, 80)) : item.compressed ? item.summary : item.text))
    .filter(Boolean)
    .join("\n");

export function userText(input: {
  contextModules: ContextModules;
  ledger: Ledger;
  turn: Turn;
  memories: { project: MemoryRecord[]; conversation: MemoryRecord[]; turn: MemoryRecord[] };
  toolUsage: string;
  compactMemory?: boolean;
}): string {
  const { contextModules, ledger, turn, memories, toolUsage } = input;
  return renderSlots(contextModules.userInventory, contextModules.userSlots, {
    "#skill": contextModules.skill,
    "#projectMemory": memoryBody(memories.project),
    "#conversationMemory": memoryBody(memories.conversation, input.compactMemory),
    "#turnMemory": memoryBody(memories.turn, input.compactMemory),
    "#contextSummary": ledger.contextSummary ? jsonBody(ledger.contextSummary) : "",
    "#observation": jsonBody(ledger.observation),
    "#notes": jsonBody(ledger.notes),
    "#userInputHistory": ledger.userInputHistory.join("\n"),
    "#userInput": turn.input.text,
    "#goal": ledger.goal,
    "#goalHistory": jsonBody(ledger.goalHistory),
    "#currentTab": turn.assembled.currentTab ? jsonBody(turn.assembled.currentTab) : "",
    "#currentPage": turn.assembled.currentPage ? jsonBody(turn.assembled.currentPage) : "",
    "#toolIO": jsonBody(ledger.toolIO),
    "#tools": toolUsage,
  });
}

export function windowChars(system: string, user: string): number {
  return system.length + user.length;
}
