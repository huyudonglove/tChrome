import { runtimeConfig } from '../config/runtime.ts';

/** Hard ceiling for one assembled window. Past it the turn fails; no slot is degraded or written out. */
export const CONTEXT_INLINE_CHARS = runtimeConfig.context.hardLimitChars;

export class ContextBudgetError extends Error {
  override name = 'ContextBudgetError';
}
