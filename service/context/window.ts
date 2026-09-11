import type { Ledger, Turn } from "../types.ts";
import { interpolate, renderInventory, renderSlots, type ContextModules } from "./modules.ts";

import { goalHistoryView, goalView, inputHistoryView, pageView, turnSummaryView, type TurnSummary } from "./projections/records.ts";
import { toolHistoryView } from "./projections/tools.ts";
import { queryView, type QueryEvidence } from "./projections/queries.ts";

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
  conversationSummaries?: TurnSummary[];
  currentQuery?: QueryEvidence | null;
  queryHistory?: QueryEvidence[];
}): string {
  const { contextModules, ledger, turn, memories, toolUsage } = input;
  return renderSlots(contextModules.userOrder, contextModules.userSlots, {
    "#skill": input.skillText,
    "#projectMemory": memories.project,
    "#conversationMemory": memories.conversation,
    "#notes": jsonBody(ledger.notes),
    "#userInputHistory": jsonBody(inputHistoryView(ledger.userInputHistory)),
    "#userInput": jsonBody({ id: turn.input.id, turnId: turn.turnId, userInput: turn.input.text }),
    "#conversationHistorySummary": jsonBody(turnSummaryView(input.conversationSummaries)),
    "#goal": jsonBody(goalView(ledger.goal)),
    "#goalHistory": jsonBody(goalHistoryView(ledger.goalHistory)),
    "#currentPage": turn.assembled.currentPage ? jsonBody(pageView(turn.assembled.currentPage)) : "",
    "#pageObservedHistory": jsonBody((turn.assembled.pageObservedHistory ?? []).map(pageView)),
    "#toolIO": jsonBody(toolHistoryView(ledger.toolIO)),
    "#queryHistory": jsonBody((input.queryHistory ?? []).map(queryView)),
    "#currentQuery": jsonBody(input.currentQuery ? queryView(input.currentQuery) : null),
    "#tools": toolUsage,
  });
}

export function windowChars(system: string, user: string): number {
  return system.length + user.length;
}
