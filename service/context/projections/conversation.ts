import type { GoalRecord, Ledger, Observation, Task, TaskHistoryRecord, Turn, TurnOutput, UserInputRecord } from "../../types.ts";
import type { MemoryRecord } from "../../memory/types.ts";
import { goalRecordView, pageView, turnSummaryView, type TurnSummary } from "./records.ts";
import { toolHistoryView } from "./tools.ts";
import { queryView, type QueryEvidence, type QueryViewOptions } from "./queries.ts";

export type ConversationTurnSlice = {
  turnId: string;
  userInput: { id: string; turnId: string; userInput: string };
  goal: { currentGoalId: string | null; goals: ReturnType<typeof goalRecordView>[] };
  task: {
    currentGoalId: string | null;
    activeTaskId: string | null;
    activeTaskItemId: string | null;
    task: ReturnType<typeof taskView> | null;
    events: TaskHistoryRecord[];
  };
  toolIO: ReturnType<typeof toolHistoryView>;
  observations: ReturnType<typeof pageView>[];
  notes: Record<string, string>;
  reflection: { turnId: string; items: { id: string; text: string; focus?: string }[] } | null;
  query: ReturnType<typeof queryView>[];
  output: TurnOutput | null;
};

export type ConversationPayload = {
  conversationMemory: MemoryRecord[] | string;
  conversationHistorySummary: TurnSummary[] | string;
  turns: ConversationTurnSlice[];
};

const taskView = (plan: Task | null | undefined) => {
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
};

const groupByTurn = <T extends { turnId: string }>(rows: T[], turnId: string) => rows.filter((row) => row.turnId === turnId);

/** Rebuild turn slices from ledger arrays + the live turn; covered turns are already filtered upstream. */
export function conversationPayload(input: {
  ledger: Ledger;
  turn: Turn;
  memories: { conversation: MemoryRecord[] | string };
  conversationSummaries?: TurnSummary[] | string;
  currentQuery?: QueryEvidence | null;
  queryHistory?: QueryEvidence[];
  gate: QueryViewOptions & { path?: (query: QueryEvidence) => string | undefined };
  /** Per-turn notes snapshots; live notes always land on the active turn. */
  notesByTurn?: Record<string, Record<string, string>>;
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
  const goalChangesByTurn = new Map<string, GoalRecord[]>();
  for (const goal of ledger.goals) {
    const rows = goalChangesByTurn.get(goal.turnId) ?? [];
    rows.push(goal);
    goalChangesByTurn.set(goal.turnId, rows);
  }
  for (const goal of turn.goalChanges) {
    const rows = goalChangesByTurn.get(goal.turnId) ?? [];
    if (!rows.some((row) => row.id === goal.id && row.updatedAt === goal.updatedAt)) rows.push(goal);
    goalChangesByTurn.set(goal.turnId, rows);
  }

  const turns: ConversationTurnSlice[] = [];
  const seen = new Set<string>();
  for (const row of inputs) {
    if (seen.has(row.turnId)) continue;
    seen.add(row.turnId);
    const isLive = row.turnId === turn.turnId;
    const goals = goalChangesByTurn.get(row.turnId) ?? [];
    const activeIds = new Set(
      (isLive ? ledger.goals : goals)
        .filter((goal) => goal.status === "active")
        .flatMap((goal) => (goal.parentId ? [goal.id, goal.parentId] : [goal.id])),
    );
    const taskEvents = groupByTurn(ledger.taskHistory, row.turnId);
    const liveTask = isLive && ledger.activeTaskId ? ledger.tasks.find((plan) => plan.id === ledger.activeTaskId) : null;
    const toolRows = groupByTurn(ledger.toolIO, row.turnId);
    const pages = pagesByTurn.get(row.turnId) ?? [];
    turns.push({
      turnId: row.turnId,
      userInput: { id: row.id, turnId: row.turnId, userInput: row.userInput },
      goal: {
        currentGoalId: isLive ? ledger.currentGoalId : null,
        goals: (isLive ? ledger.goals.filter((goal) => activeIds.has(goal.id)) : goals).map(goalRecordView),
      },
      task: {
        currentGoalId: isLive ? ledger.currentGoalId : null,
        activeTaskId: isLive ? ledger.activeTaskId : null,
        activeTaskItemId: isLive ? ledger.activeTaskItemId : null,
        task: isLive ? taskView(liveTask) : null,
        events: taskEvents,
      },
      toolIO: toolHistoryView(toolRows, pages),
      observations: pages.map(pageView),
      notes: (isLive ? ledger.notes : notesByTurn[row.turnId]) ?? {},
      reflection: reflectByTurn.get(row.turnId)?.length
        ? { turnId: row.turnId, items: reflectByTurn.get(row.turnId)! }
        : null,
      query: groupByTurn(queries, row.turnId).map((query) => ({
        ...queryView(query, { ...gate, path: gate.path?.(query) }),
        ...(input.currentQuery && query.queryId === input.currentQuery.queryId ? { currentQuery: true } : {}),
      })),
      output: isLive ? turn.output : null,
    });
  }
  return {
    conversationMemory: input.memories.conversation,
    conversationHistorySummary: Array.isArray(input.conversationSummaries)
      ? turnSummaryView(input.conversationSummaries)
      : input.conversationSummaries ?? [],
    turns,
  };
}

const jsonBody = (value: unknown) => JSON.stringify(value, null, 2);
const tag = (name: string, value: unknown) => `<${name}>\n${typeof value === "string" ? value : jsonBody(value)}\n</${name}>`;

/** Nested XML body for the conversation module data section. */
export function conversationXml(payload: ConversationPayload): string {
  const parts = [
    tag("conversationMemory", payload.conversationMemory),
    tag("conversationHistorySummary", payload.conversationHistorySummary),
  ];
  for (const raw of payload.turns) {
    if (raw && typeof raw === "object" && "contextFile" in (raw as object) && !("turnId" in (raw as object))) {
      parts.push(tag("externalizedTurn", raw));
      continue;
    }
    const slice = raw as ConversationTurnSlice;
    const fields = [
      tag("userInput", slice.userInput),
      tag("goal", slice.goal),
      tag("task", slice.task),
      tag("toolIO", slice.toolIO),
      tag("observations", slice.observations),
      tag("notes", slice.notes),
      tag("reflection", slice.reflection),
      tag("query", slice.query),
      tag("output", slice.output),
    ].filter((block) => !/^<(\w+)>\n(null|""|\[\]|\{\})\n<\/\1>$/.test(block));
    parts.push(`<${slice.turnId}>\n${fields.join("\n")}\n</${slice.turnId}>`);
  }
  return parts.join("\n");
}
