export type LoopSummary = { id: string; loopIds: string[]; summary: string; userRequest: string; actions: string; result: string; reflection?: string; level?: number; from?: string[] };
export const loopSummaryView = (records: LoopSummary[] = []) => records.map(({ id, ...record }) => ({ sumId: id, ...record }));
