import type { Ledger, Turn } from "../types.ts";
import { renderSlots, systemTextFromModules, type ContextModules, type SlotAttributes } from "./modules.ts";

import { conversationPayload, conversationXml } from "./projections/conversation.ts";
import { type QueryEvidence } from "./projections/queries.ts";
import { CONTEXT_INLINE_CHARS, ContextBudgetError } from "./overflow.ts";
import { runtimeConfig } from "../config/runtime.ts";

export function systemText(
  contextModules: ContextModules,
  currentDate: string,
  baseToolGuide = "",
  env: { cwd?: string; os?: string; dataDir?: string } = {},
  skillGuide = "",
): string {
  return systemTextFromModules(contextModules, currentDate, baseToolGuide, env, skillGuide);
}

export function userText(input: {
  contextModules: ContextModules;
  ledger: Ledger;
  turn: Turn;
  memories: { project: string; conversation: string };
  skillText: string;
  toolGuide?: string;
  conversationSummaries?: Parameters<typeof conversationPayload>[0]["conversationSummaries"];
  queryHistory?: QueryEvidence[];
  inlineBudget?: { dataDir: string; system: string };
  /** Data directory for archive callers; projection itself reads ledger loops. */
  dataDir?: string;
}): string {
  const { contextModules, ledger, turn, memories } = input;
  const conversationData = conversationPayload({
    ledger,
    memories: { conversation: memories.conversation },
    conversationSummaries: input.conversationSummaries,
  });
  const slots = {
    "#skill": input.skillText,
    "#projectMemory": memories.project,
    "#tools": input.toolGuide ?? "",
    "#conversation": "",
    "#contextUsage": "",
  };
  const render = (values: Record<string, string>, attributes: SlotAttributes = {}) =>
    renderSlots(contextModules.userOrder, contextModules.userSlots, values, attributes);
  const xmlValues = { ...slots, "#conversation": conversationXml(conversationData) };
  // Mutable capacity data belongs at the end of User to preserve the historical prefix.
  let attributes: SlotAttributes = { "#conversation": { id: ledger.conversationId } };
  if (input.inlineBudget) {
    // The read-out counts its own attribute text, so iterate to a fixed point: the settled
    // attributes are exactly the ones the reported chars was measured with.
    for (let round = 0; round < 5; round++) {
      const chars = windowChars(input.inlineBudget.system, render(xmlValues, attributes));
      const next: SlotAttributes = { "#conversation": { id: ledger.conversationId }, "#contextUsage": budgetReadout(chars) };
      if (JSON.stringify(next) === JSON.stringify(attributes)) break;
      attributes = next;
    }
  }
  if (input.inlineBudget) {
    const chars = Number(attributes["#contextUsage"]?.chars ?? 0);
    if (chars > CONTEXT_INLINE_CHARS) {
      throw new ContextBudgetError(`Context inline budget exceeded: ${chars} characters; limit is ${CONTEXT_INLINE_CHARS}`);
    }
  }
  return render(xmlValues, attributes);
}

/** Window occupancy as the model reads it: absolute size always paired with the limit it is measured against. */
function budgetReadout(chars: number): Record<string, string> {
  const limit = runtimeConfig.context.compressAtChars;
  return { chars: String(chars), compressAt: String(limit), used: `${Math.round((chars / limit) * 100)}%` };
}

export function windowChars(system: string, user: string): number {
  return system.length + user.length;
}
