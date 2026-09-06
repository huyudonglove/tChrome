import type { Ledger, MemoryRecord, Turn } from "../types.ts";
import { SYSTEM_SLOTS, USER_SLOTS, type Catalog } from "../prompt/catalog.ts";

export const MEMORY_WINDOW = 8;

const slotBlock = (name: string, body: string) => (body ? `${name}\n${body}` : name);

const jsonBody = (value: unknown) => JSON.stringify(value, null, 2);

export function systemText(catalog: Catalog): string {
  return SYSTEM_SLOTS.map((name) => {
    if (name === "#skill") return slotBlock(name, catalog.skill);
    if (name === "#sop") return slotBlock(name, catalog.sop);
    return slotBlock(name, catalog.pack[name] ?? "");
  }).join("\n\n");
}

const memoryBody = (items: MemoryRecord[]) =>
  items
    .slice(-MEMORY_WINDOW)
    .map((item) => (item.compressed ? item.summary : item.text))
    .filter(Boolean)
    .join("\n");

export function userText(input: {
  ledger: Ledger;
  turn: Turn;
  memories: { project: MemoryRecord[]; conversation: MemoryRecord[]; turn: MemoryRecord[] };
  toolUsage: string;
}): string {
  const { ledger, turn, memories, toolUsage } = input;
  const bodies: Record<(typeof USER_SLOTS)[number], string> = {
    "#projectMemory": memoryBody(memories.project),
    "#conversationMemory": memoryBody(memories.conversation),
    "#turnMemory": memoryBody(memories.turn),
    "#contextSummary": ledger.contextSummary ? jsonBody(ledger.contextSummary) : "",
    "#observation": jsonBody(ledger.observation),
    "#userInputHistory": ledger.userInputHistory.join("\n"),
    "#userInput": turn.input.text,
    "#currentEnvironment": turn.assembled.currentPage ? jsonBody(turn.assembled.currentPage) : "",
    "#toolIO": jsonBody(ledger.toolIO),
    "#tools": toolUsage,
  };
  return USER_SLOTS.map((name) => slotBlock(name, bodies[name])).join("\n\n");
}

export function windowChars(system: string, user: string): number {
  return system.length + user.length;
}
