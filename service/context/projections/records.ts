import type { LastAction, Observation, UserInputRecord } from "../../types.ts";

// Select model-facing fields without changing archival records.
export const inputHistoryView = (records: UserInputRecord[]) => records.map(({ id, turnId, userInput }) => ({ id, turnId, userInput }));
export const pageView = (page: Observation) => ({
  id: page.id,
  turnId: page.turnId,
  callId: page.callId,
  ...(page.batchId ? { batchId: page.batchId } : {}),
  tabId: page.tabId,
  type: page.type,
  result: page.result,
  ...(page.taskId !== undefined ? { taskId: page.taskId } : {}),
  ...(page.taskItemId !== undefined ? { taskItemId: page.taskItemId } : {}),
});

/** Replace-only pointer to the latest model-returned tool batch. */
export const lastActionView = (action: LastAction | null) => action;


/** One summary row; a large turn may have several rows sharing the same turnId. */
export type TurnSummary = { id: string; turnId: string; tag: string; userRequest: string; actions: string; result: string; reflection?: string };
export const turnSummaryView = (records: TurnSummary[] = []) => records.map(({ id, turnId, tag, userRequest, actions, result, reflection }) => ({ sumId: id, turnId, tag, userRequest, actions, result, ...(reflection ? { reflection } : {}) }));
