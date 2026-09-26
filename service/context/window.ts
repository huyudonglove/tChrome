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
}): string {
  const { contextModules, ledger, turn, memories } = input;
  const gate = {
    inlineChars: runtimeConfig.results.inlineChars,
    previewChars: runtimeConfig.results.previewChars,
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
  });
  const slots = {
    "#skill": input.skillText,
    "#projectMemory": memories.project,
    // Only the active page is in-window; use tabs.current for the full list.
    "#currentOpen": jsonBody({ turnId: turn.turnId, ...currentOpenPage(turn) }),
    // JSON while externalizing so turn slices can be referenced individually; XML after.
    "#conversation": jsonBody(conversationData),
    "#tools": input.toolGuide ?? "",
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

/** Single open page for the window slot; full tab list comes from tabs.current. */
function currentOpenPage(turn: Turn): Record<string, unknown> {
  const snapshot = turn.assembled.currentTabs;
  if (snapshot.ok) {
    const focused = snapshot.windows.find((window) => window.focused) ?? snapshot.windows[0];
    const active = focused?.tabs.find((tab) => tab.active) ?? focused?.tabs[0];
    if (active) return { ok: true, tabId: active.tabId, url: active.url, title: active.title, description: "当前打开页" };
    return { ok: false, error: "没有打开中的标签" };
  }
  // Failed reads stay explicit; never pretend the last known page is still current.
  return { ok: false, error: snapshot.error };
}
