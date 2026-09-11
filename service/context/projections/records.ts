import type { CurrentPage, GoalRecord, UserInputRecord } from "../../types.ts";

// Select model-facing fields without changing archival records.
export const inputHistoryView = (records: UserInputRecord[]) => records.map(record => record.userInput);
export const goalView = (record: GoalRecord | null) => record?.goal ?? null;
export const goalHistoryView = (records: GoalRecord[]) => records.map(record => record.goal);
export const pageView = (page: CurrentPage) => ({ tab: page.tab, url: page.url, title: page.title, description: page.description });

export type SummaryViews = Partial<Record<"userInputHistory" | "pageObservedHistory" | "conversationMemory" | "toolIO", Array<{ tag: string; summary: string }>>>;
export const summaryView = (summaries: Array<{ tag: string; summary: string }> = []) => summaries.map(({ tag, summary }) => ({ tag, summary }));
