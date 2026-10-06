import { groupWorkspaceEvidence } from "../../runtime/workspace.ts";
import type { Ledger, Observation, Task, TaskHistoryRecord, Turn, TurnStopReason, UserInputRecord, WorkspaceEntry, RuntimeNotice } from "../../types.ts";
import type { MemoryRecord } from "../../memory/types.ts";
import { pageView, turnSummaryView, type TurnSummary } from "./records.ts";
import { toolHistoryView } from "./tools.ts";
import { queryView, type QueryEvidence, type QueryViewOptions } from "./queries.ts";
import { loadTurn } from "../../runtime/store.ts";

export type ConversationTurnSlice = {
  turnId: string;
  userInput: { id: string; turnId: string; userInput: string };
  /** First–last callId of this turn (ids are per-conversation sequential). */
  callBounds: { from: string; to: string; kept: number; total: number } | null;
  calls: ReturnType<typeof toolHistoryView>;
  observations: ReturnType<typeof pageView>[];
  /** Runtime 自动记录的操作证据，保留来源轮次。 */
  workspace: WorkspaceEntry[];
  notes: Ledger["notes"];
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
  notesByTurn?: Record<string, Ledger["notes"]>;
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
  const latestBatch = ledger.lastAction?.turnId === turn.turnId ? ledger.lastAction : null;
  const latestCallIds = new Set(latestBatch?.calls.map(call => call.callId) ?? []);

  const turns: ConversationTurnSlice[] = [];
  const seen = new Set<string>();
  for (const [inputIndex, row] of inputs.entries()) {
    if (seen.has(row.turnId)) continue;
    seen.add(row.turnId);
    const currentTurn = inputIndex + 1;
    const isLive = row.turnId === turn.turnId;
    const toolRows = groupByTurn(ledger.toolIO, row.turnId);
    const pages = pagesByTurn.get(row.turnId) ?? [];
    const visibleCalls = toolRows.filter(record => record.arguments.keepInCalls === true
      || (isLive && record.batchId === latestBatch?.batchId && latestCallIds.has(record.callId)));
    turns.push({
      turnId: row.turnId,
      userInput: { id: row.id, turnId: row.turnId, userInput: row.userInput },
      callBounds: toolRows.length
        ? { from: toolRows[0]!.callId, to: toolRows.at(-1)!.callId, kept: visibleCalls.length, total: toolRows.length }
        : null,
      calls: toolHistoryView(visibleCalls, pages, workspaceByTurn.get(row.turnId) ?? []),
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
const USER_INPUT_ATTRS = ["id"];
const OBSERVATION_ATTRS = ["id", "callId", "type", "taskId", "taskItemId", "writtenTurn", "validUntilTurn"];
const MEMORY_ATTRS = ["memoryId", "turnId", "sourceCallId"];
const SUMMARY_ATTRS = ["sumId", "turnId", "summary", "level", "turnIds", "from"];
const REFLECT_ATTRS = ["id", "focus"];
const QUERY_ATTRS = ["id", "sumId", "module", "status", "ok", "faultCode", "sourceCallId", "externalized", "totalChars", "path", "search"];
const TASK_ATTRS = ["id", "title", "status", "createdTurnId", "updatedTurnId"];
const TASK_ITEM_ATTRS = ["id", "status", "expectedEffect", "verification", "blockedReason", "outcome"];
const STOP_ATTRS = ["kind", "callId"];
// Envelope fields omitted from the body; turnId stays in storage only.
const CALL_ENVELOPE_KEYS = ["callId", "turnId", "name"];

/** Objects share one view; each operation retains its immutable source identities. */
const workspaceXml = (entries: WorkspaceEntry[]): string => {
  if (!entries.length) return "";
  const body = groupWorkspaceEvidence(entries).map(group =>
    tag("workspace", { operations: group.operations }, { kind: group.target.kind, key: group.target.key })
  ).join("\n");
  return `<workspaces>\n${body}\n</workspaces>`;
};

/** Runtime 提醒：同 kind 只保留最新一条。 */
export const runtimeNoticesXml = (notices: RuntimeNotice[]): string => {
  if (!notices.length) return "";
  const body = notices.map((notice) => {
    const attrs = attrText({ id: notice.id, kind: notice.kind, scope: notice.scope });
    return `<notice${attrs}>\n${notice.text}\n</notice>`;
  }).join("\n");
  return body;
};

const notesXml = (notes: Ledger["notes"]): string => {
  const entries = Object.entries(notes);
  if (!entries.length) return "";
  const body = entries
    .map(([key, note]) => `<note${attr("id", note.id)}${attr("key", key)}>\n${note.value}\n</note>`)
    .join("\n");
  return `<notes${attrText({ start: entries[0]![1].id, end: entries.at(-1)![1].id })}>\n${body}\n</notes>`;
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
  const ids = items.map((item) => String((asRecord(item) ?? {}).id ?? ""));
  const body = items.map((item) => recordXml("reflect", asRecord(item) ?? {}, REFLECT_ATTRS)).join("\n");
  return `<reflections${attrText({ start: ids[0]!, end: ids.at(-1)! })}>\n${body}\n</reflections>`;
};

const stopReasonXml = (stop: unknown): string => {
  const record = asRecord(stop);
  if (!record) return "";
  const attrs = attrText(pickAttrs(record, STOP_ATTRS));
  const text = typeof record.text === "string" ? record.text : jsonBody(record.text);
  return `<stopReason${attrs}>\n${text}\n</stopReason>`;
};

/** Turn call entry: envelope keys plus outcome flags as attributes, result in the body. */
const callXml = (value: unknown): string => {
  const record = asRecord(value);
  if (!record) return "";
  const ret = asRecord(record.return) ?? {};
  const result = asRecord(ret.result);
  const attrs: Record<string, string> = {};
  if (typeof record.callId === "string") attrs.callId = record.callId;
  if (typeof record.name === "string") attrs.name = record.name;
  if (typeof result?.ok === "boolean") attrs.ok = String(result.ok);
  const body = pickBody(record, CALL_ENVELOPE_KEYS);
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
        return wrapList("summaries", items, { start: first.sumId ?? "", end: last?.sumId ?? "" });
      })()
    : (typeof summariesRaw === "string" && summariesRaw
      ? `<summaries>\n${summariesRaw}\n</summaries>`
      : "");
  const parts = [
    listXml("ConverstionMemories", payload.conversationMemory, MEMORY_ATTRS),
    summaryBlock,
    taskXml(payload.task),
    workspaceXml(payload.turns.flatMap(slice => slice.workspace)),
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
      .map(({ queryId, ...query }) => element("query", { id: queryId, ...query }, QUERY_ATTRS))
      .filter(Boolean);
    const queryBounds = queries.length
      ? {
          start: (slice.query[0] as { queryId?: string }).queryId ?? "",
          end: (slice.query.at(-1) as { queryId?: string } | undefined)?.queryId ?? "",
        }
      : undefined;
    const fields = [
      element("userInput", slice.userInput, USER_INPUT_ATTRS),
      ...(slice.calls.length ? [
        `<calls${slice.callBounds ? attrText({ start: slice.callBounds.from, end: slice.callBounds.to, kept: String(slice.callBounds.kept), total: String(slice.callBounds.total) }) : ""}>\n${slice.calls.map(callXml).join("\n")}\n</calls>`,
      ] : []),
      wrapList("observations", observations, obsBounds),
      notesXml(slice.notes),
      reflectionXml(slice.reflection),
      wrapList("queries", queries, queryBounds),
      stopReasonXml(slice.stopReason),
    ].filter(Boolean);
    const turnAttrs: Record<string, string> = { turnId: slice.turnId };
    if (slice.callBounds) {
      turnAttrs.start = slice.callBounds.from;
      turnAttrs.end = slice.callBounds.to;
    }
    parts.push(`<turn${attrText(turnAttrs)}>\n${fields.join("\n")}\n</turn>`);
  }
  return parts.join("\n");
}
