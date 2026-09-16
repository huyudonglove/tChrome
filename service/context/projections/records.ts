import type { GoalRecord, LastAction, PageObservation, UserInputRecord } from "../../types.ts";

// Select model-facing fields without changing archival records.
export const inputHistoryView = (records: UserInputRecord[]) => records.map(({ id, turnId, userInput }) => ({ id, turnId, userInput }));
export const goalRecordView = ({ id, parentId, status, turnId, sourceCallId, goal }: GoalRecord) => ({ id, parentId, status, turnId, sourceCallId, goal });
export const activeGoalIds = (records: GoalRecord[]) => new Set(records.filter(row => row.status === "active").flatMap(row => row.parentId ? [row.id, row.parentId] : [row.id]));
export const goalView = (records: GoalRecord[], currentGoalId: string | null) => {
  const ids = activeGoalIds(records);
  return { currentGoalId, goals: records.filter(row => ids.has(row.id)).map(goalRecordView) };
};
export const goalHistoryView = (records: GoalRecord[]) => records.filter(row => row.status !== "active").map(goalRecordView);
export const pageView = (page: PageObservation) => ({
  id: page.id,
  turnId: page.turnId,
  callId: page.callId,
  ...(page.batchId ? { batchId: page.batchId } : {}),
  tabId: page.tabId,
  type: page.type,
  result: page.result,
});

/** Replace-only pointer to the latest model-returned tool batch. */
export const lastActionView = (action: LastAction | null) => action;


export type TurnSummary = { id: string; turnId: string; tag: string; userRequest: string; actions: string; result: string };
export const turnSummaryView = (records: TurnSummary[] = []) => records.map(({ id, turnId, tag, userRequest, actions, result }) => ({ sumId: id, turnId, tag, userRequest, actions, result }));
