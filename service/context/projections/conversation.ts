import type { Ledger, Observation, Task, TaskHistoryRecord, Turn, TurnStopReason, UserInputRecord, WorkspaceEntry } from "../../types.ts";
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
  callBounds: { from: string; to: string } | null;
  observations: ReturnType<typeof pageView>[];
  /** 因果工作区条目（本轮 workspace_write 写下），窗口不限量。 */
  workspace: WorkspaceEntry[];
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
  const workspaceByTurn = new Map<string, WorkspaceEntry[]>();
  for (const entry of turn.assembled.workspace ?? []) {
    const rows = workspaceByTurn.get(entry.turnId) ?? [];
    rows.push(entry);
    workspaceByTurn.set(entry.turnId, rows);
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
      callBounds: toolRows.length
        ? { from: toolRows[0]!.callId, to: toolRows.at(-1)!.callId }
        : null,
      observations: pages.map((page) => pageView(page, currentTurn)).filter((page) => page !== null),
      workspace: workspaceByTurn.get(row.turnId) ?? [],
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

/** Compact JSON: the window pays per byte, so body payloads carry no indentation. */
const jsonBody = (value: unknown) => JSON.stringify(value);
/** Attribute values are data, not markup. */
const attr = (name: string, value: string) => ` ${name}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
const attrText = (attributes: Record<string, string>) =>
  Object.entries(attributes).map(([k, v]) => attr(k, v)).join("");
const tag = (name: string, value: unknown, attributes?: Record<string, string>) => {
  const attrs = attributes ? attrText(attributes) : "";
  return `<${name}${attrs}>\n${typeof value === "string" ? value : jsonBody(value)}\n</${name}>`;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const pickAttrs = (record: Record<string, unknown>, keys: string[]): Record<string, string> => {
  const attrs: Record<string, string> = {};
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    attrs[key] = typeof value === "string" ? value : jsonBody(value);
  }
  return attrs;
};

const pickBody = (record: Record<string, unknown>, keys: string[]): Record<string, unknown> => {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (keys.includes(key) || value === undefined) continue;
    body[key] = value;
  }
  return body;
};

/**
 * One record as one element: the listed scalar keys become attributes, everything else
 * stays in the body. Nothing is dropped, only relocated — that is the whole point.
 */
const recordXml = (name: string, record: Record<string, unknown>, keys: string[]): string => {
  const attrs = attrText(pickAttrs(record, keys));
  const body = pickBody(record, keys);
  return Object.keys(body).length ? `<${name}${attrs}>\n${jsonBody(body)}\n</${name}>` : `<${name}${attrs} />`;
};

const element = (name: string, value: unknown, keys: string[]): string => {
  const record = asRecord(value);
  return record ? recordXml(name, record, keys) : "";
};

/** projectMemories() hands over JSON text while other slots pass prose; only arrays are claimed. */
const tryParseArray = (text: string): unknown[] | null => {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** A list of records as sibling elements; pre-serialized JSON is parsed into the same shape. */
const listXml = (name: string, items: unknown, keys: string[]): string => {
  if (typeof items === "string") {
    const parsed = tryParseArray(items);
    return parsed ? parsed.map((item) => element(name, item, keys)).filter(Boolean).join("\n") : items;
  }
  if (!Array.isArray(items)) return "";
  return items.map((item) => element(name, item, keys)).filter(Boolean).join("\n");
};

/** Scalar keys lifted to attributes, per record shape (see projections/). */
const USER_INPUT_ATTRS = ["id", "turnId", "submittedAt"];
const OBSERVATION_ATTRS = ["id", "turnId", "callId", "batchId", "tabId", "type", "taskId", "taskItemId", "writtenTurn", "validUntilTurn"];
const MEMORY_ATTRS = ["memoryId", "turnId", "layer", "createdAt", "sourceCallId"];
const SUMMARY_ATTRS = ["sumId", "turnId", "tag", "level", "turnIds", "from"];
const REFLECT_ATTRS = ["id", "focus"];
const QUERY_ATTRS = ["queryId", "turnId", "sumId", "module", "status", "ok", "faultCode", "sourceCallId", "currentQuery", "externalized", "totalChars", "totalLines", "lineWidth", "path", "search"];
const TASK_ATTRS = ["id", "title", "status", "createdTurnId", "updatedTurnId"];
const TASK_ITEM_ATTRS = ["id", "status", "expectedEffect", "verification", "blockedReason", "outcome"];
const STOP_ATTRS = ["kind", "callId"];
const CALL_ATTRS = ["callId", "turnId", "batchId", "name"];

/** 因果工作区：<workspace from首条id to末条id> 包 <ws id boundid callIds>，body 为 {op, value}。不限量。 */
const workspaceXml = (entries: WorkspaceEntry[]): string => {
  if (!entries.length) return "";
  const bounds = attrText({ from: entries[0]!.id, to: entries.at(-1)!.id });
  const body = entries.map((entry) => {
    const attrs = attrText({
      id: entry.id,
      boundid: entry.boundId,
      ...(entry.callIds.length ? { callIds: entry.callIds.join(",") } : {}),
    });
    return `<ws${attrs}>\n${jsonBody({ op: entry.op, value: entry.value })}\n</ws>`;
  }).join("\n");
  return `<workspace${bounds}>\n${body}\n</workspace>`;
};

const notesXml = (notes: unknown): string => {  const record = asRecord(notes);
  if (!record) return "";
  const entries = Object.entries(record);
  if (!entries.length) return "";
  const body = entries
    .map(([key, value]) => `<note${attr("key", key)}>\n${typeof value === "string" ? value : jsonBody(value)}\n</note>`)
    .join("\n");
  return `<notes>\n${body}\n</notes>`;
};

const taskXml = (plan: unknown): string => {
  const record = asRecord(plan);
  if (!record) return "";
  const attrs = attrText(pickAttrs(record, TASK_ATTRS));
  const items = Array.isArray(record.items) ? record.items : [];
  if (!items.length) return `<task${attrs} />`;
  const body = items.map((item) => recordXml("item", asRecord(item) ?? {}, TASK_ITEM_ATTRS)).join("\n");
  return `<task${attrs}>\n${body}\n</task>`;
};

const reflectionXml = (reflection: unknown): string => {
  const record = asRecord(reflection);
  if (!record) return "";
  const items = Array.isArray(record.items) ? record.items : [];
  if (!items.length) return "";
  const attrs = attrText(pickAttrs(record, ["turnId"]));
  const body = items.map((item) => recordXml("reflect", asRecord(item) ?? {}, REFLECT_ATTRS)).join("\n");
  return `<reflection${attrs}>\n${body}\n</reflection>`;
};

const stopReasonXml = (stop: unknown): string => {
  const record = asRecord(stop);
  if (!record) return "";
  const attrs = attrText(pickAttrs(record, STOP_ATTRS));
  const text = typeof record.text === "string" ? record.text : jsonBody(record.text);
  return `<stopReason${attrs}>\n${text}\n</stopReason>`;
};

/** Tool pool entry: envelope keys plus outcome flags as attributes, arguments and result in the body. */
const callXml = (value: unknown): string => {
  const record = asRecord(value);
  if (!record) return "";
  const ret = asRecord(record.return) ?? {};
  const result = asRecord(ret.result);
  const attrs: Record<string, string> = pickAttrs(record, CALL_ATTRS);
  if (ret.stage !== undefined) attrs.stage = String(ret.stage);
  if (typeof result?.ok === "boolean") attrs.ok = String(result.ok);
  const body = pickBody(record, CALL_ATTRS);
  body.return = ret.result !== undefined ? ret.result : ret;
  return `<call${attrText(attrs)}>\n${jsonBody(body)}\n</call>`;
};

/** Nested XML body for the conversation module data section. */
export function conversationXml(payload: ConversationPayload): string {
  const parts = [
    listXml("memory", payload.conversationMemory, MEMORY_ATTRS),
    listXml("summary", payload.conversationHistorySummary, SUMMARY_ATTRS),
    taskXml(payload.task),
  ].filter(Boolean);
  for (const raw of payload.turns) {
    const slice = raw as ConversationTurnSlice;
    const fields = [
      element("userInput", slice.userInput, USER_INPUT_ATTRS),
      listXml("observation", slice.observations, OBSERVATION_ATTRS),
      workspaceXml(slice.workspace ?? []),
      notesXml(slice.notes),
      reflectionXml(slice.reflection),
      listXml("query", slice.query, QUERY_ATTRS),
      stopReasonXml(slice.stopReason),
    ].filter(Boolean);
    const turnAttrs: Record<string, string> = { turnId: slice.turnId };
    if (slice.callBounds) {
      turnAttrs.from = slice.callBounds.from;
      turnAttrs.to = slice.callBounds.to;
    }
    parts.push(`<turn${attrText(turnAttrs)}>\n${fields.join("\n")}\n</turn>`);
  }
  // Shared tool pool at the bottom: session range as attributes + newest call details only.
  const bounds = payload.toolIOBounds;
  const pool = Array.isArray(payload.toolIO) ? payload.toolIO.map(callXml).filter(Boolean).join("\n") : "";
  parts.push(
    `<toolIO${bounds ? attrText({ from: bounds.from, to: bounds.to, kept: String(bounds.kept), total: String(bounds.total) }) : ""}>\n${pool}\n</toolIO>`,
  );
  return parts.join("\n");
}
