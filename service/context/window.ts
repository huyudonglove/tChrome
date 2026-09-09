import type { Ledger, MemoryRecord, Turn } from "../types.ts";
import { renderInventory, renderSlots, type ContextModules } from "./modules.ts";

export const MEMORY_WINDOW = 8;

const jsonBody = (value: unknown) => JSON.stringify(value, null, 2);

export function systemText(contextModules: ContextModules, baseToolUsage: string): string {
  return [renderInventory("System", contextModules.systemOrder, contextModules.systemSlots, {
    "#baseTools": baseToolUsage,
  }), contextModules.userInventory].join("\n\n");
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
  return renderSlots(contextModules.userOrder, contextModules.userSlots, {
    "#projectMemory": memoryBody(memories.project),
    "#conversationMemory": memoryBody(memories.conversation, input.compactMemory),
    "#turnMemory": memoryBody(memories.turn, input.compactMemory),
    "#contextSummary": ledger.contextSummary ? jsonBody(ledger.contextSummary) : "",
    "#observation": jsonBody(ledger.observation),
    "#notes": jsonBody(ledger.notes),
    "#userInputHistory": jsonBody(ledger.userInputHistory),
    "#userInput": turn.input.text,
    "#goal": ledger.goal,
    "#goalHistory": jsonBody(ledger.goalHistory),
    "#currentPage": turn.assembled.currentPage ? jsonBody(turn.assembled.currentPage) : "",
    "#pageObservedHistory": jsonBody(turn.assembled.pageObservedHistory ?? []),
    "#toolIO": jsonBody(ledger.toolIO),
    "#tools": toolUsage,
  });
}

export function windowChars(system: string, user: string): number {
  return system.length + user.length;
}
