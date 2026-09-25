import type { Ledger, Turn } from "../types.ts";
import { join } from "node:path";
import { interpolate, renderSlots, systemTextFromModules, type ContextModules } from "./modules.ts";

import { goalHistoryView, goalView, inputHistoryView, lastActionView, pageView, turnSummaryView, type TurnSummary } from "./projections/records.ts";
import { projectActiveContext } from "./projections/active-context.ts";
import { toolHistoryView } from "./projections/tools.ts";
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
  conversationSummaries?: TurnSummary[];
  currentQuery?: QueryEvidence | null;
  queryHistory?: QueryEvidence[];
  inlineBudget?: { dataDir: string; system: string };
}): string {
  const { contextModules, ledger, turn, memories } = input;
  const pageHistory = turn.assembled.pageObservedHistory;
  const pages = pageHistory;
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
  const slots = {
    "#skill": input.skillText,
    "#projectMemory": memories.project,
    "#conversationMemory": memories.conversation,
    // Turn-scoped info package: workspace snapshots also carry the active turnId.
    "#notes": jsonBody({ turnId: turn.turnId, notes: ledger.notes }),
    "#reflection": jsonBody(turn.reflect?.length ? { turnId: turn.turnId, items: turn.reflect } : null),
    "#reflectHistory": jsonBody(ledger.reflectHistory),
    "#userInputHistory": jsonBody(inputHistoryView(ledger.userInputHistory)),
    "#userInput": jsonBody({ id: turn.input.id, turnId: turn.turnId, userInput: turn.input.text }),
    "#conversationHistorySummary": jsonBody(turnSummaryView(input.conversationSummaries)),
    "#goal": jsonBody(goalView(ledger.goals, ledger.currentGoalId)),
    "#goalHistory": jsonBody(goalHistoryView(ledger.goals)),
    "#openTabs": jsonBody({ turnId: turn.turnId, ...turn.assembled.openTabs }),
    "#pageObservedHistory": jsonBody(pageHistory.map(pageView)),
    "#toolIO": jsonBody(toolHistoryView(ledger.toolIO, pages)),
    "#lastAction": jsonBody(lastActionView(ledger.lastAction ?? null)),
    "#activeContext": jsonBody(projectActiveContext({ ledger, turn })),
    "#plan": jsonBody({
      currentGoalId: ledger.currentGoalId,
      activePlanId: ledger.activePlanId,
      activePlanItemId: ledger.activePlanItemId,
      plan: ledger.activePlanId
        ? (() => {
          const plan = ledger.plans.find((row) => row.id === ledger.activePlanId);
          if (!plan) return null;
          return {
            id: plan.id,
            goalId: plan.goalId,
            ...(plan.title ? { title: plan.title } : {}),
            status: plan.status,
            items: plan.items.map((item) => ({
              id: item.id,
              text: item.text,
              status: item.status,
              ...(item.expectedEffect ? { expectedEffect: item.expectedEffect } : {}),
              ...(item.verification ? { verification: item.verification } : {}),
              ...(item.blockedReason ? { blockedReason: item.blockedReason } : {}),
            })),
          };
        })()
        : null,
    }),
    "#queryHistory": jsonBody((input.queryHistory ?? []).map((query) => queryView(query, { ...gate, path: queryPath(query) }))),
    "#currentQuery": jsonBody(input.currentQuery ? queryView(input.currentQuery, { ...gate, path: queryPath(input.currentQuery) }) : null),
    "#tools": input.toolGuide ?? "",
  };
  const render = (values: Record<string, string>) => renderSlots(contextModules.userOrder, contextModules.userSlots, values);
  return render(input.inlineBudget ? externalizeContext({
    dataDir: input.inlineBudget.dataDir, slots,
    measure: values => windowChars(input.inlineBudget!.system, render(values)),
  }) : slots);
}

export function windowChars(system: string, user: string): number {
  return system.length + user.length;
}
