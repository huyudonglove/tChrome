import type { Ledger, MemoryRecord, Turn } from "../types.ts";
import { renderSlots, toolUsageFor, type Catalog } from "../prompt/catalog.ts";

export const MEMORY_WINDOW = 8;

const jsonBody = (value: unknown) => JSON.stringify(value, null, 2);

export function systemText(catalog: Catalog): string {
  return renderSlots(catalog.systemTemplate, catalog.systemSlots, {
    "#baseTools": toolUsageFor(catalog, catalog.assemble.baseToolsIds),
  });
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
  toolUsage: string;
}): string {
  const { catalog, ledger, turn, memories, toolUsage } = input;
  return renderSlots(catalog.userTemplate, catalog.userSlots, {
    "#skill": catalog.skill,
    "#projectMemory": memoryBody(memories.project),
    "#conversationMemory": memoryBody(memories.conversation),
    "#turnMemory": memoryBody(memories.turn),
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
