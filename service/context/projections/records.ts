import type { CurrentPage, GoalRecord, PageObservation, UserInputRecord } from "../../types.ts";

// Select model-facing fields without changing archival records.
export const inputHistoryView = (records: UserInputRecord[]) => records.map(({ id, turnId, userInput }) => ({ id, turnId, userInput }));
export const goalView = (record: GoalRecord | null) => record ? { id: record.id, turnId: record.turnId, sourceCallId: record.sourceCallId, goal: record.goal } : null;
export const goalHistoryView = (records: GoalRecord[]) => records.map(goalView);
export const pageView = (page: CurrentPage & Partial<PageObservation>) => ({ id: page.id, turnId: page.turnId, callId: page.callId, tab: page.tab, url: page.url, title: page.title, description: page.description });


export type TurnSummary = { id: string; turnId: string; tag: string; userRequest: string; actions: string; result: string };
export const turnSummaryView = (records: TurnSummary[] = []) => records.map(({ id, turnId, tag, userRequest, actions, result }) => ({ sumId: id, turnId, tag, userRequest, actions, result }));
