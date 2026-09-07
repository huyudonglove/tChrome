import type { Ledger, MemoryRecord, Turn } from "../types.ts";
import { interpolate, slotNames, type Catalog } from "../prompt/catalog.ts";

export const MEMORY_WINDOW = 8;

const jsonBody = (value: unknown) => JSON.stringify(value, null, 2);

export function systemText(catalog: Catalog): string {
  const slots: Record<string, string> = {};
  for (const name of slotNames(catalog.systemTemplate)) {
    slots[name] = catalog.pack[name] ?? "";
  }
  return interpolate(catalog.systemTemplate, slots);
}

const memoryBody = (items: MemoryRecord[]) =>
  items
    .slice(-MEMORY_WINDOW)
    .map((item) => (item.compressed ? item.summary : item.text))
    .filter(Boolean)
    .join("\n");

export function userText(input: {
  catalog: Catalog;
  ledger: Ledger;
  turn: Turn;
  memories: { project: MemoryRecord[]; conversation: MemoryRecord[]; turn: MemoryRecord[] };
  baseToolUsage: string;
  toolUsage: string;
}): string {
  const { catalog, ledger, turn, memories, baseToolUsage, toolUsage } = input;
  return interpolate(catalog.userTemplate, {
    "#参考": catalog.advice,
    "#skill": catalog.skill,
    "#sop": catalog.sop,
    "#projectMemory": memoryBody(memories.project),
    "#conversationMemory": memoryBody(memories.conversation),
    "#turnMemory": memoryBody(memories.turn),
    "#contextSummary": ledger.contextSummary ? jsonBody(ledger.contextSummary) : "",
    "#observation": jsonBody(ledger.observation),
    "#userInputHistory": ledger.userInputHistory.join("\n"),
    "#userInput": turn.input.text,
    "#goal": ledger.goal,
    "#goalHistory": jsonBody(ledger.goalHistory),
    "#currentPage": turn.assembled.currentTab ? jsonBody(turn.assembled.currentTab) : "",
    "#currentEnvironment": turn.assembled.currentPage ? jsonBody(turn.assembled.currentPage) : "",
    "#toolIO": jsonBody(ledger.toolIO),
    "#baseTools": baseToolUsage,
    "#tools": toolUsage,
  });
}

export function windowChars(system: string, user: string): number {
  return system.length + user.length;
}
