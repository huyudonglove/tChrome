import type { Ledger, Turn } from "../types.ts";
import { join } from "node:path";
import { renderSlots, systemTextFromModules, type ContextModules, type SlotAttributes } from "./modules.ts";

import { conversationPayload, conversationXml } from "./projections/conversation.ts";
import { queryView, type QueryEvidence } from "./projections/queries.ts";
import { CONTEXT_INLINE_CHARS, ContextBudgetError } from "./overflow.ts";
import { runtimeConfig } from "../config/runtime.ts";
import { paths } from "../runtime/store.ts";

const jsonBody = (value: unknown) => JSON.stringify(value, null, 2);

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
  /** Restores settled turns' <stopReason> from disk when not in inlineBudget. */
  dataDir?: string;
}): string {
  const { contextModules, ledger, turn, memories } = input;
  const gate = {
    inlineChars: runtimeConfig.results.inlineChars,
    previewChars: runtimeConfig.results.previewChars,
    summaryChars: runtimeConfig.results.summaryChars,
    searchContextChars: runtimeConfig.results.searchContextChars,
    lineWidth: runtimeConfig.results.lineWidth,
  };
  const queryPath = (query: QueryEvidence) =>
    input.inlineBudget?.dataDir && query.sourceCallId
      ? join(paths(input.inlineBudget.dataDir, ledger.conversationId).returns, `${query.sourceCallId}.txt`)
      : undefined;
  const conversationData = conversationPayload({
    ledger,
    turn,
    memories: { conversation: memories.conversation },
    conversationSummaries: input.conversationSummaries,
    queryHistory: input.queryHistory,
    gate: { ...gate, path: queryPath },
    dataDir: input.dataDir ?? input.inlineBudget?.dataDir,
  });
  const slots = {
    "#skill": input.skillText,
    "#projectMemory": memories.project,
    "#tools": input.toolGuide ?? "",
    "#conversation": jsonBody(conversationData),
  };
  const render = (values: Record<string, string>, attributes: SlotAttributes = {}) =>
    renderSlots(contextModules.userOrder, contextModules.userSlots, values, attributes);
  const settled = slots;
  const xmlValues = conversationXmlSlots(settled);
  // <conversation> self-reports who it is and how much of the window it costs. The read-out counts
  // its own attribute text, so settle it by iterating instead of trusting a single measure.
  let attributes: SlotAttributes = { "#conversation": { id: ledger.conversationId } };
  if (input.inlineBudget) {
    // The read-out counts its own attribute text, so iterate to a fixed point: the settled
    // attributes are exactly the ones the reported chars was measured with.
    for (let round = 0; round < 5; round++) {
      const chars = windowChars(input.inlineBudget.system, render(xmlValues, attributes));
      const next: SlotAttributes = { "#conversation": { id: ledger.conversationId, ...budgetReadout(chars) } };
      if (JSON.stringify(next) === JSON.stringify(attributes)) break;
      attributes = next;
    }
  }
  if (input.inlineBudget) {
    const chars = Number(attributes["#conversation"]?.chars ?? 0);
    if (chars > CONTEXT_INLINE_CHARS) {
      throw new ContextBudgetError(`Context inline budget exceeded: ${chars} characters; limit is ${CONTEXT_INLINE_CHARS}`);
    }
  }
  return render(xmlValues, attributes);
}

/** Window occupancy as the model reads it: absolute size always paired with the limit it is measured against. */
function budgetReadout(chars: number): Record<string, string> {
  const limit = runtimeConfig.context.compressAtChars;
  return { chars: String(chars), limit: String(limit), used: `${Math.round((chars / limit) * 100)}%` };
}

/** The conversation slot holds a JSON array of turns; render it as nested XML. */
function conversationXmlSlots(values: Record<string, string>): Record<string, string> {
  const body = values["#conversation"] ?? "";
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return values; }
  return { ...values, "#conversation": conversationXml(parsed as Parameters<typeof conversationXml>[0]) };
}

export function windowChars(system: string, user: string): number {
  return system.length + user.length;
}
