import type { Ledger, Turn } from "../types.ts";
import { join } from "node:path";
import { renderSlots, systemTextFromModules, type ContextModules } from "./modules.ts";

import { conversationPayload, conversationXml } from "./projections/conversation.ts";
import { queryView, type QueryEvidence } from "./projections/queries.ts";
import { externalizeContext } from "./overflow.ts";
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
  currentQuery?: QueryEvidence | null;
  queryHistory?: QueryEvidence[];
  inlineBudget?: { dataDir: string; system: string };
  /** Restores settled turns' <output> from disk when not in inlineBudget. */
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
    currentQuery: input.currentQuery,
    queryHistory: input.queryHistory,
    gate: { ...gate, path: queryPath },
    dataDir: input.dataDir ?? input.inlineBudget?.dataDir,
  });
  const slots = {
    "#skill": input.skillText,
    "#projectMemory": memories.project,
    "#tools": input.toolGuide ?? "",
    // JSON while externalizing so turn slices can be referenced individually; XML after.
    "#conversation": jsonBody(conversationData),
  };
  const render = (values: Record<string, string>) => renderSlots(contextModules.userOrder, contextModules.userSlots, values);
  const settled = input.inlineBudget ? externalizeContext({
    dataDir: input.inlineBudget.dataDir, slots,
    measure: values => windowChars(input.inlineBudget!.system, render(conversationXmlSlots(values))),
  }) : slots;
  return render(conversationXmlSlots(settled));
}

/** conversation slot stays JSON during externalize; render nested XML unless already a file reference. */
function conversationXmlSlots(values: Record<string, string>): Record<string, string> {
  const body = values["#conversation"] ?? "";
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return values; }
  if (parsed && typeof parsed === "object" && "contextFile" in (parsed as object)) return values;
  return { ...values, "#conversation": conversationXml(parsed as Parameters<typeof conversationXml>[0]) };
}

export function windowChars(system: string, user: string): number {
  return system.length + user.length;
}
