import type { LastAction, Observation, UserInputRecord } from "../../types.ts";

// Select model-facing fields without changing archival records.
export const inputHistoryView = (records: UserInputRecord[]) => records.map(({ id, turnId, userInput }) => ({ id, turnId, userInput }));
/**
 * `currentTurn` is the 1-based ordinal of the turn being assembled.
 * An observation whose validUntilTurn has passed is dropped (returns null) instead of
 * being injected as a fact that no longer holds: a stale observation is either gone or
 * was worth keeping, and worth keeping belongs in memory (memory.write / memory.update).
 */
export const pageView = (page: Observation, currentTurn?: number) =>
  (page.validUntilTurn !== undefined && currentTurn !== undefined && currentTurn > page.validUntilTurn)
    ? null
    : {
        id: page.id,
        turnId: page.turnId,
        callId: page.callId,
        ...(page.batchId ? { batchId: page.batchId } : {}),
        tabId: page.tabId,
        type: page.type,
        result: page.result,
        ...(page.taskId !== undefined ? { taskId: page.taskId } : {}),
        ...(page.taskItemId !== undefined ? { taskItemId: page.taskItemId } : {}),
        ...(page.writtenTurn !== undefined ? { writtenTurn: page.writtenTurn } : {}),
        ...(page.validUntilTurn !== undefined ? { validUntilTurn: page.validUntilTurn } : {}),
      };

/** Replace-only pointer to the latest model-returned tool batch. */
export const lastActionView = (action: LastAction | null) => action;


/** One summary row; a large turn may have several rows sharing the same turnId. */
export type TurnSummary = { id: string; turnId: string; tag: string; userRequest: string; actions: string; result: string; reflection?: string; turnIds?: string[] };
export const turnSummaryView = (records: TurnSummary[] = []) => records.map(({ id, turnId, tag, userRequest, actions, result, reflection, turnIds }) => ({ sumId: id, turnId, tag, userRequest, actions, result, ...(reflection ? { reflection } : {}), ...(turnIds?.length ? { turnIds } : {}) }));
