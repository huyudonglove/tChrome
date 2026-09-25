import type { Ledger, OpenTabs, PageObservation, TaskItem, ToolIOItem, Turn } from "../../types.ts";

export type ActiveContextView = {
  goalId: string | null;
  activeTaskItem: {
    id: string;
    text: string;
    expectedEffect?: string;
    verification?: string;
    blockedReason?: string;
  } | null;
  focus: {
    primaryTabId: number | null;
    primaryTabTitle: string | null;
    urlPrefix: string | null;
  };
  activeEntities: Record<string, string>;
  handoverIntent: string | null;
};

const planItemView = (item: TaskItem): ActiveContextView["activeTaskItem"] => ({
  id: item.id,
  text: item.text,
  ...(item.expectedEffect ? { expectedEffect: item.expectedEffect } : {}),
  ...(item.verification ? { verification: item.verification } : {}),
  ...(item.blockedReason ? { blockedReason: item.blockedReason } : {}),
});

const pickTaskItem = (ledger: Ledger): TaskItem | null => {
  if (!ledger.activeTaskId) return null;
  const plan = ledger.tasks.find((row) => row.id === ledger.activeTaskId);
  if (!plan || plan.status !== "active") return null;
  const doing = plan.items.find((item) => item.status === "doing");
  if (doing) return doing;
  return plan.items.find((item) => item.status === "todo") ?? null;
};

const tabIdFromValue = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return null;
  return value;
};

const tabIdFromTool = (row: ToolIOItem): number | null => {
  const fromArgs = tabIdFromValue(row.arguments?.tabId);
  if (fromArgs !== null) return fromArgs;
  try {
    const parsed = JSON.parse(row.return.text) as Record<string, unknown>;
    return tabIdFromValue(parsed?.tabId);
  } catch {
    return null;
  }
};

const tabIdFromObservation = (row: PageObservation): number | null =>
  tabIdFromValue((row.result as Record<string, unknown> | undefined)?.tabId) ?? tabIdFromValue(row.tabId);

/** Last two model batches by batchId/callId order already stored on the ledger (append order). */
const recentToolRows = (ledger: Ledger): ToolIOItem[] => {
  const batches: string[] = [];
  for (const row of ledger.toolIO) {
    const key = row.batchId ?? row.callId;
    if (batches.at(-1) !== key) batches.push(key);
  }
  const recent = new Set(batches.slice(-2));
  return ledger.toolIO.filter((row) => recent.has(row.batchId ?? row.callId));
};

const findPrimaryTab = (ledger: Ledger, turn: Turn): ActiveContextView["focus"] => {
  const counts = new Map<number, number>();
  const bump = (tabId: number | null) => {
    if (tabId === null) return;
    counts.set(tabId, (counts.get(tabId) ?? 0) + 1);
  };
  for (const row of recentToolRows(ledger)) bump(tabIdFromTool(row));
  for (const row of turn.assembled.pageObservedHistory) bump(tabIdFromObservation(row));

  let primaryTabId: number | null = null;
  let best = 0;
  for (const [tabId, count] of counts) {
    if (count > best || (count === best && primaryTabId !== null && tabId > primaryTabId)) {
      best = count;
      primaryTabId = tabId;
    }
  }

  const openTabs: OpenTabs = turn.assembled.openTabs;
  const flatten = openTabs.ok
    ? openTabs.windows.flatMap((window) => window.tabs.map((tab) => ({ window, tab })))
    : [];
  let match = primaryTabId === null
    ? undefined
    : flatten.find((row) => row.tab.tabId === primaryTabId);
  if (!match) {
    const focused = flatten.find((row) => row.window.focused && row.tab.active)
      ?? flatten.find((row) => row.tab.active);
    if (focused) primaryTabId = focused.tab.tabId;
    match = focused;
  }

  const tab = match?.tab;
  let urlPrefix: string | null = null;
  if (tab?.url) {
    try {
      const parsed = new URL(tab.url);
      if (parsed.origin && parsed.origin !== "null") {
        urlPrefix = parsed.origin;
      } else if (parsed.protocol) {
        urlPrefix = parsed.host ? `${parsed.protocol}//${parsed.host}` : parsed.protocol;
      } else {
        urlPrefix = tab.url;
      }
    } catch {
      urlPrefix = tab.url;
    }
  }
  return {
    primaryTabId: primaryTabId ?? null,
    primaryTabTitle: tab?.title ? tab.title : null,
    urlPrefix,
  };
};

/** Design: keep entity-sized fields only; bulk draft logs stay in <notes>. */
const MAX_ENTITY_CHARS = 80;

const flattenEntityValue = (key: string, value: unknown, into: Record<string, string>): void => {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    // Multi-line values are typically scratch logs, not identity entities.
    if (value.includes("\n")) return;
    if (value.length > MAX_ENTITY_CHARS) return;
    if (value.trim()) into[key] = value;
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    into[key] = String(value);
    return;
  }
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")) {
      const joined = value.map(String).join(",");
      if (joined.length <= MAX_ENTITY_CHARS) into[key] = joined;
    }
    return;
  }
  if (typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      flattenEntityValue(childKey, childValue, into);
    }
  }
};

const collectEntities = (notes: Record<string, string>): Record<string, string> => {
  const into: Record<string, string> = {};
  for (const [key, raw] of Object.entries(notes)) {
    if (!raw.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [childKey, childValue] of Object.entries(parsed as Record<string, unknown>)) {
          flattenEntityValue(childKey, childValue, into);
        }
        continue;
      }
    } catch {
      // not JSON — treat as scalar note
    }
    flattenEntityValue(key, raw, into);
  }
  return into;
};

const handoverIntent = (ledger: Ledger, item: ActiveContextView["activeTaskItem"]): string | null => {
  const lastTurn = ledger.reflectHistory.at(-1);
  const last = lastTurn?.items.at(-1);
  if (last?.text.trim()) return last.text.trim();
  return item?.text ?? null;
};

/** Pure assembly-time spine: no ledger writes, no extra tools, no disk reads. */
export function projectActiveContext(input: {
  ledger: Ledger;
  turn: Turn;
}): ActiveContextView {
  const { ledger, turn } = input;
  const item = pickTaskItem(ledger);
  const planItem = item ? planItemView(item) : null;
  return {
    goalId: ledger.currentGoalId,
    activeTaskItem: planItem,
    focus: findPrimaryTab(ledger, turn),
    activeEntities: collectEntities(ledger.notes),
    handoverIntent: handoverIntent(ledger, planItem),
  };
}
