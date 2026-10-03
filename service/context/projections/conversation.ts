import type { Ledger, Observation, Task, TaskHistoryRecord, Turn, TurnStopReason, UserInputRecord } from "../../types.ts";
import type { MemoryRecord } from "../../memory/types.ts";
import { pageView, turnSummaryView, type TurnSummary } from "./records.ts";
import { toolHistoryView } from "./tools.ts";
import { queryView, type QueryEvidence, type QueryViewOptions } from "./queries.ts";
import { runtimeConfig } from "../../config/runtime.ts";
import { loadTurn } from "../../runtime/store.ts";

export type ConversationTurnSlice = {
  turnId: string;
  userInput: { id: string; turnId: string; userInput: string };
  /** First–last callId of this turn (ids are per-conversation sequential). */
  callRange: string | null;
  observations: ReturnType<typeof pageView>[];
  notes: Record<string, string>;
  reflection: { turnId: string; items: { id: string; text: string; focus?: string }[] } | null;
  query: ReturnType<typeof queryView>[];
  stopReason: TurnStopReason | null;
};

export type ConversationTaskPayload = ReturnType<typeof taskView>;

export type ConversationPayload = {
  conversationMemory: MemoryRecord[] | string;
  conversationHistorySummary: ReturnType<typeof turnSummaryView> | string;
  task: ConversationTaskPayload;
  turns: ConversationTurnSlice[];
  /** Shared rolling pool: newest calls across all turns. */
  toolIO: ReturnType<typeof toolHistoryView>;
  /** Pool bounds; rendered as <toolIO> attributes so the range is readable without opening the pool. */
  toolIOBounds: { from: string; to: string; kept: number; total: number } | null;
};

const taskView = (plan: Task | null | undefined) => {
  if (!plan) return null;
  return {
    id: plan.id,
    ...(plan.title ? { title: plan.title } : {}),
    status: plan.status,
    ...(plan.createdTurnId ? { createdTurnId: plan.createdTurnId } : {}),
    ...(plan.updatedTurnId ? { updatedTurnId: plan.updatedTurnId } : {}),
    items: plan.items.map((item) => ({
      id: item.id,
      text: item.text,
      status: item.status,
      ...(item.expectedEffect ? { expectedEffect: item.expectedEffect } : {}),
      ...(item.verification ? { verification: item.verification } : {}),
      ...(item.blockedReason ? { blockedReason: item.blockedReason } : {}),
      ...(item.outcome ? { outcome: item.outcome } : {}),
    })),
  };
};

const groupByTurn = <T extends { turnId?: string }>(rows: T[], turnId: string) => rows.filter((row) => row.turnId === turnId);

/** Rebuild turn slices from ledger arrays + the live turn; covered turns are already filtered upstream. */
export function conversationPayload(input: {
  ledger: Ledger;
  turn: Turn;
  memories: { conversation: MemoryRecord[] | string };
  conversationSummaries?: TurnSummary[] | string;
  currentQuery?: QueryEvidence | null;
  queryHistory?: QueryEvidence[];
  gate: Omit<QueryViewOptions, "path"> & { path?: (query: QueryEvidence) => string | undefined };
  /** Per-turn notes snapshots; live notes always land on the active turn. */
  notesByTurn?: Record<string, Record<string, string>>;
  /** Needed to restore settled turns' <output> from disk. */
  dataDir?: string;
}): ConversationPayload {
  const { ledger, turn, gate } = input;
  const inputs: UserInputRecord[] = [
    ...ledger.userInputHistory,
    { id: turn.input.id, turnId: turn.turnId, userInput: turn.input.text, submittedAt: turn.input.submittedAt },
  ];
  const reflectByTurn = new Map<string, { id: string; text: string; focus?: string }[]>();
  for (const row of ledger.reflectHistory) reflectByTurn.set(row.turnId, row.items);
  if (turn.reflect?.length) reflectByTurn.set(turn.turnId, turn.reflect);
  const pagesByTurn = new Map<string, Observation[]>();
  for (const page of turn.assembled.observations) {
    const rows = pagesByTurn.get(page.turnId) ?? [];
    rows.push(page);
    pagesByTurn.set(page.turnId, rows);
  }
  const queries: QueryEvidence[] = [...(input.queryHistory ?? [])];
  if (input.currentQuery) queries.push(input.currentQuery);
  const notesByTurn = input.notesByTurn ?? {};
  // Newest tool calls keep their detail; everything older collapses to pointers.
  const ringCallIds = new Set(ledger.toolIO.slice(-runtimeConfig.context.toolioRingSize).map((row) => row.callId));

  const turns: ConversationTurnSlice[] = [];
  const seen = new Set<string>();
  for (const [inputIndex, row] of inputs.entries()) {
    if (seen.has(row.turnId)) continue;
    seen.add(row.turnId);
    const currentTurn = inputIndex + 1;
    const isLive = row.turnId === turn.turnId;
    const toolRows = groupByTurn(ledger.toolIO, row.turnId);
    const pages = pagesByTurn.get(row.turnId) ?? [];
    turns.push({
      turnId: row.turnId,
      userInput: { id: row.id, turnId: row.turnId, userInput: row.userInput },
      callRange: toolRows.length
        ? (toolRows[0]!.callId === toolRows.at(-1)!.callId
          ? toolRows[0]!.callId
          : `${toolRows[0]!.callId}–${toolRows.at(-1)!.callId}`)
        : null,
      observations: pages.map((page) => pageView(page, currentTurn)).filter((page) => page !== null),
      notes: (isLive ? ledger.notes : notesByTurn[row.turnId]) ?? {},
      reflection: reflectByTurn.get(row.turnId)?.length
        ? { turnId: row.turnId, items: reflectByTurn.get(row.turnId)! }
        : null,
      query: groupByTurn(queries, row.turnId).map((query) => ({
        ...queryView(query, { ...gate, path: gate.path?.(query) }),
        ...(input.currentQuery && query.queryId === input.currentQuery.queryId ? { currentQuery: true } : {}),
      })),
      stopReason: isLive
        ? turn.stopReason
        : (input.dataDir
          ? (() => {
            try { return loadTurn(input.dataDir!, ledger.conversationId, row.turnId).stopReason; }
            catch { return null; }
          })()
          : null),
    });
  }
  const sessionCalls = ledger.toolIO;
  const activePlan = ledger.activeTaskId ? ledger.tasks.find((plan) => plan.id === ledger.activeTaskId) : null;
  const latestPlan = activePlan ?? ledger.tasks.at(-1) ?? null;
  const taskPayload: ConversationTaskPayload = taskView(latestPlan);
  return {
    conversationMemory: input.memories.conversation,
    conversationHistorySummary: Array.isArray(input.conversationSummaries)
      ? turnSummaryView(input.conversationSummaries)
      : input.conversationSummaries ?? [],
    task: taskPayload,
    turns,
    toolIO: toolHistoryView(sessionCalls.slice(-runtimeConfig.context.toolioRingSize), [], ringCallIds),
    toolIOBounds: sessionCalls.length
      ? {
          from: sessionCalls[0]!.callId,
          to: sessionCalls.at(-1)!.callId,
          kept: Math.min(sessionCalls.length, runtimeConfig.context.toolioRingSize),
          total: sessionCalls.length,
        }
      : null,
  };
}

const jsonBody = (value: unknown) => JSON.stringify(value, null, 2);
/** Attribute values are data, not markup. */
const attr = (name: string, value: string) => ` ${name}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
const tag = (name: string, value: unknown, attributes?: Record<string, string>) => {
  const attrs = attributes ? Object.entries(attributes).map(([k, v]) => attr(k, v)).join("") : "";
  return `<${name}${attrs}>\n${typeof value === "string" ? value : jsonBody(value)}\n</${name}>`;
};

/** Nested XML body for the conversation module data section. */
export function conversationXml(payload: ConversationPayload): string {
  const emptyTag = /^<(\w+)(?:\s[^>]*)?>\n(null|""|\[\]|\{\})\n<\/\1>$/;
  const parts = [
    tag("conversationMemory", payload.conversationMemory),
    tag("conversationHistorySummary", payload.conversationHistorySummary),
    tag("task", payload.task),
  ].filter((block) => !emptyTag.test(block));
  for (const raw of payload.turns) {
    if (raw && typeof raw === "object" && "contextFile" in (raw as object) && !("turnId" in (raw as object))) {
      parts.push(tag("externalizedTurn", raw));
      continue;
    }
    const slice = raw as ConversationTurnSlice;
    const fields = [
      tag("userInput", slice.userInput),
      ...(slice.callRange ? [tag("callRange", slice.callRange)] : []),
      tag("observations", slice.observations),
      tag("notes", slice.notes),
      tag("reflection", slice.reflection),
      tag("query", slice.query),
      tag("stopReason", slice.stopReason),
    ].filter((block) => !emptyTag.test(block));
    parts.push(`<${slice.turnId}>\n${fields.join("\n")}\n</${slice.turnId}>`);
  }
  // Shared tool pool at the bottom: session range as attributes + newest call details only.
  const bounds = payload.toolIOBounds;
  parts.push(
    tag("toolIO", payload.toolIO, bounds
      ? { from: bounds.from, to: bounds.to, kept: String(bounds.kept), total: String(bounds.total) }
      : undefined),
  );
  return parts.join("\n");
}
