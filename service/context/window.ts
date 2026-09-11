import { inputRecord } from "../runtime/ids.ts";
import type { Ledger, Turn } from "../types.ts";
import { interpolate, renderInventory, renderSlots, type ContextModules } from "./modules.ts";

const jsonBody = (value: unknown) => JSON.stringify(value, null, 2);

export function systemText(contextModules: ContextModules, baseToolUsage: string, currentDate: string): string {
  return [interpolate(contextModules.overview, { currentDate }), renderInventory("System", contextModules.systemOrder, contextModules.systemSlots, {
    "#baseTools": baseToolUsage,
  }), contextModules.userInventory].join("\n\n");
}

export function userText(input: {
  contextModules: ContextModules;
  ledger: Ledger;
  turn: Turn;
  memories: { project: string; conversation: string };
  toolUsage: string;
  skillText: string;
}): string {
  const { contextModules, ledger, turn, memories, toolUsage } = input;
  return renderSlots(contextModules.userOrder, contextModules.userSlots, {
    "#skill": input.skillText,
    "#projectMemory": memories.project,
    "#conversationMemory": memories.conversation,
    "#observation": jsonBody(ledger.observation),
    "#notes": jsonBody(ledger.notes),
    "#userInputHistory": jsonBody(ledger.userInputHistory),
    "#userInput": jsonBody(inputRecord(turn)),
    "#goal": jsonBody(ledger.goal),
    "#goalHistory": jsonBody(ledger.goalHistory),
    "#currentPage": turn.assembled.currentPage ? jsonBody(turn.assembled.currentPage) : "",
    "#pageObservedHistory": jsonBody(turn.assembled.pageObservedHistory ?? []),
    "#toolIO": jsonBody(ledger.toolIO),
    // Compression slots are placeholders until the compression agent is connected.
    "#userInputHistorySummary": jsonBody([]),
    "#pageObservedHistorySummary": jsonBody([]),
    "#conversationMemorySummary": jsonBody([]),
    "#toolIOSummary": jsonBody([]),
    "#tools": toolUsage,
  });
}

export function windowChars(system: string, user: string): number {
  return system.length + user.length;
}
