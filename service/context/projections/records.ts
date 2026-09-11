import type { CurrentPage, GoalRecord, UserInputRecord } from "../../types.ts";

// Select model-facing fields without changing archival records.
export const inputHistoryView = (records: UserInputRecord[]) => records.map(record => record.userInput);
export const goalView = (record: GoalRecord | null) => record?.goal ?? null;
export const goalHistoryView = (records: GoalRecord[]) => records.map(record => record.goal);
export const pageView = (page: CurrentPage) => ({ tab: page.tab, url: page.url, title: page.title, description: page.description });


export type TurnSummary = { turnId: string; tag: string; userRequest: string; actions: string; result: string };
export const turnSummaryView = (records: TurnSummary[] = []) => records.map(({ tag, userRequest, actions, result }) => ({ tag, userRequest, actions, result }));
