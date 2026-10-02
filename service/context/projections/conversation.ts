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
  /** Session-wide first–last callId; detail lives only in the shared toolIO pool below. */
  toolRange: string | null;
  /** Shared rolling pool: newest calls across all turns. */
  /** Session-wide reflection tally: how many反思 this session has, and the latest focus. */
  reflectionStatus: { count: number; latestId?: string; latestFocus?: string } | null;
  toolIO: ReturnType<typeof toolHistoryView>;
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
  const reflectItems = [...reflectByTurn.values()].flat();
  const latestReflect = reflectItems[reflectItems.length - 1];
  const reflectionStatus = reflectItems.length
    ? {
        count: reflectItems.length,
        ...(latestReflect?.id ? { latestId: latestReflect.id } : {}),
        ...(latestReflect?.focus ? { latestFocus: latestReflect.focus } : {}),
      }
    : null;
  const sessionCalls = ledger.toolIO;
  const activePlan = ledger.activeTaskId ? ledger.tasks.find((plan) => plan.id === ledger.activeTaskId) : null;
  const latestPlan = activePlan ?? ledger.tasks.at(-1) ?? null;
  const taskPayload: ConversationTaskPayload = taskView(latestPlan);
  return {
    reflectionStatus,
    conversationMemory: input.memories.conversation,
    conversationHistorySummary: Array.isArray(input.conversationSummaries)
      ? turnSummaryView(input.conversationSummaries)
      : input.conversationSummaries ?? [],
    task: taskPayload,
    turns,
    toolRange: sessionCalls.length
      ? (sessionCalls[0]!.callId === sessionCalls.at(-1)!.callId
        ? sessionCalls[0]!.callId
        : `${sessionCalls[0]!.callId}–${sessionCalls.at(-1)!.callId}`)
      : null,
    toolIO: toolHistoryView(sessionCalls.slice(-runtimeConfig.context.toolioRingSize), [], ringCallIds),
  };
}

const jsonBody = (value: unknown) => JSON.stringify(value, null, 2);
const tag = (name: string, value: unknown) => `<${name}>\n${typeof value === "string" ? value : jsonBody(value)}\n</${name}>`;

/** Nested XML body for the conversation module data section. */
export function conversationXml(payload: ConversationPayload): string {
  const emptyTag = /^<(\w+)>\n(null|""|\[\]|\{\})\n<\/\1>$/;
  const parts = [
    tag("reflectionStatus", payload.reflectionStatus),
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
  // Shared tool pool at the bottom: session range + newest call details only.
  if (payload.toolRange) {
    parts.push(tag("toolRange", `${payload.toolRange}（全会话工具调用范围；详情仅保留最近 10 次，更早按轮内 callRange 用 evidence_search(callId) 取回）`));
  }
  parts.push(tag("toolIO", payload.toolIO));
  return parts.join("\n");
}
