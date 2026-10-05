import type { Ledger, Observation, Task, TaskHistoryRecord, Turn, TurnStopReason, UserInputRecord, WorkspaceEntry, RuntimeNotice } from "../../types.ts";
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
  /** Runtime 运行时提醒：与 turn 平级，不再零散缀在各条返回后面。 */
  runtime: RuntimeNotice[];
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
  for (const entry of turn.assembled.workspace) {
    const rows = workspaceByTurn.get(entry.turnId) ?? [];
    rows.push(entry);
    workspaceByTurn.set(entry.turnId, rows);
  }
  const queries: QueryEvidence[] = [...(input.queryHistory ?? [])];
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
      query: groupByTurn(queries, row.turnId).map((query) => queryView(query, { ...gate, path: gate.path?.(query) })),
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
    runtime: ledger.runtimeNotices,
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

/** projectMemories() hands over XML text for project memories (conversation memories stay JSON); only arrays are claimed. */
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
const USER_INPUT_ATTRS = ["id", "turnId"];
const OBSERVATION_ATTRS = ["id", "callId", "tabId", "type", "taskId", "taskItemId", "writtenTurn", "validUntilTurn"];
const MEMORY_ATTRS = ["memoryId", "turnId", "sourceCallId"];
const SUMMARY_ATTRS = ["sumId", "turnId", "summary", "level", "turnIds", "from"];
const REFLECT_ATTRS = ["id", "focus"];
const QUERY_ATTRS = ["queryId", "turnId", "sumId", "module", "status", "ok", "faultCode", "sourceCallId", "externalized", "totalChars", "totalLines", "lineWidth", "path", "search"];
const TASK_ATTRS = ["id", "title", "status", "createdTurnId", "updatedTurnId"];
const TASK_ITEM_ATTRS = ["id", "status", "expectedEffect", "verification", "blockedReason", "outcome"];
const STOP_ATTRS = ["kind", "callId"];
const CALL_ATTRS = ["callId", "turnId", "name"];

/** 因果工作区：<workspace from首条id to末条id> 包 <ws id boundid callIds files?>，body 为 {op, value}。不限量。 */
const workspaceXml = (entries: WorkspaceEntry[]): string => {
  if (!entries.length) return "";
  const bounds = attrText({ start: entries[0]!.id, end: entries.at(-1)!.id });
  const body = entries.map((entry) => {
    const attrs = attrText({
      id: entry.id,
      boundid: entry.boundId,
      ...(entry.callIds.length ? { callIds: entry.callIds.join(",") } : {}),
      ...(entry.files?.length ? { files: entry.files.join(",") } : {}),
    });
    return `<ws${attrs}>\n${jsonBody({ op: entry.op, value: entry.value })}\n</ws>`;
  }).join("\n");
  return `<workspace${bounds}>\n${body}\n</workspace>`;
};

/** Runtime 提醒：同 kind 只保留最新一条。 */
const runtimeXml = (notices: RuntimeNotice[]): string => {
  if (!notices.length) return "";
  const body = notices.map((notice) => {
    const attrs = attrText({ kind: notice.kind, scope: notice.scope });
    return `<notice${attrs}>\n${notice.text}\n</notice>`;
  }).join("\n");
  return `<runtime>\n${body}\n</runtime>`;
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
  const inner = items.length
    ? `<task${attrs}>\n${items.map((item) => recordXml("item", asRecord(item) ?? {}, TASK_ITEM_ATTRS)).join("\n")}\n</task>`
    : `<task${attrs} />`;
  const id = typeof record.id === "string" ? record.id : "";
  return `<tasks${attrText({ start: id, end: id })}>\n${inner}\n</tasks>`;
};

const reflectionXml = (reflection: unknown): string => {
  const record = asRecord(reflection);
  if (!record) return "";
  const items = Array.isArray(record.items) ? record.items : [];
  if (!items.length) return "";
  const attrs = attrText(pickAttrs(record, ["turnId"]));
  const body = items.map((item) => recordXml("reflect", asRecord(item) ?? {}, REFLECT_ATTRS)).join("\n");
  return `<reflects${attrs}>\n${body}\n</reflects>`;
};

const stopReasonXml = (stop: unknown): string => {
  const record = asRecord(stop);
  if (!record) return "";
  const attrs = attrText(pickAttrs(record, STOP_ATTRS));
  const text = typeof record.text === "string" ? record.text : jsonBody(record.text);
  return `<stopReason${attrs}>\n${text}\n</stopReason>`;
};

/** Tool pool entry: envelope keys plus outcome flags as attributes, result in the body. */
const callXml = (value: unknown): string => {
  const record = asRecord(value);
  if (!record) return "";
  const ret = asRecord(record.return) ?? {};
  const result = asRecord(ret.result);
  const attrs: Record<string, string> = {};
  if (typeof record.callId === "string") attrs.callId = record.callId;
  if (typeof record.turnId === "string") attrs.turnId = record.turnId;
  if (typeof record.name === "string") attrs.name = record.name;
  if (typeof result?.ok === "boolean") attrs.ok = String(result.ok);
  const body = pickBody(record, CALL_ATTRS);
  body.return = ret.result !== undefined ? ret.result : ret;
  return `<call${attrText(attrs)}>\n${jsonBody(body)}\n</call>`;
};

/** Same-turn record lists ride in a plural container so siblings never lay flat. */
const wrapList = (tag: string, items: string[], bounds?: { start: string; end: string }): string => {
  if (!items.length) return "";
  const attrs = bounds ? attrText(bounds) : "";
  return `<${tag}${attrs}>\n${items.join("\n")}\n</${tag}>`;
};

/** Nested XML body for the conversation module data section. */
export function conversationXml(payload: ConversationPayload): string {
  const summariesRaw = payload.conversationHistorySummary;
  const summaryBlock = Array.isArray(summariesRaw)
    ? (() => {
        const items = summariesRaw
          .map((item) => element("summary", item, SUMMARY_ATTRS))
          .filter(Boolean);
        if (!items.length) return "";
        const first = summariesRaw[0] as { sumId?: string };
        const last = summariesRaw.at(-1) as { sumId?: string } | undefined;
        return wrapList("allSummary", items, { start: first.sumId ?? "", end: last?.sumId ?? "" });
      })()
    : (typeof summariesRaw === "string" && summariesRaw
      ? `<allSummary>\n${summariesRaw}\n</allSummary>`
      : "");
  const parts = [
    listXml("memory", payload.conversationMemory, MEMORY_ATTRS),
    summaryBlock,
    taskXml(payload.task),
  ].filter(Boolean);
  for (const raw of payload.turns) {
    const slice = raw as ConversationTurnSlice;
    const observations = (Array.isArray(slice.observations) ? slice.observations : [])
      .map((page) => element("observation", page, OBSERVATION_ATTRS))
      .filter(Boolean);
    const obsBounds = observations.length
      ? {
          start: (slice.observations[0] as { id?: string }).id ?? "",
          end: (slice.observations.at(-1) as { id?: string } | undefined)?.id ?? "",
        }
      : undefined;
    const queries = (Array.isArray(slice.query) ? slice.query : [])
      .map((query) => element("query", query, QUERY_ATTRS))
      .filter(Boolean);
    const fields = [
      element("userInput", slice.userInput, USER_INPUT_ATTRS),
      wrapList("observations", observations, obsBounds),
      workspaceXml(slice.workspace),
      notesXml(slice.notes),
      reflectionXml(slice.reflection),
      wrapList("querys", queries),
      stopReasonXml(slice.stopReason),
    ].filter(Boolean);
    const turnAttrs: Record<string, string> = { turnId: slice.turnId };
    if (slice.callBounds) {
      turnAttrs.start = slice.callBounds.from;
      turnAttrs.end = slice.callBounds.to;
    }
    parts.push(`<turn${attrText(turnAttrs)}>\n${fields.join("\n")}\n</turn>`);
  }
  const runtime = runtimeXml(Array.isArray(payload.runtime) ? payload.runtime : []);
  if (runtime) parts.push(runtime);
  // Shared tool pool at the bottom: session range as attributes + newest call details only.
  const bounds = payload.toolIOBounds;
  const pool = Array.isArray(payload.toolIO) ? payload.toolIO.map(callXml).filter(Boolean).join("\n") : "";
  parts.push(
    `<toolIO${bounds ? attrText({ start: bounds.from, end: bounds.to, kept: String(bounds.kept), total: String(bounds.total) }) : ""}>\n${pool}\n</toolIO>`,
  );
  return parts.join("\n");
}
