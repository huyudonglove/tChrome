import type { PageObservation, ToolIOItem } from "../../types.ts";

function resultView(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

/** Page observation payloads live in #pageObservedHistory; toolIO keeps a pointer only. */
export function toolHistoryView(records: ToolIOItem[], observations: PageObservation[] = []) {
  const byCall = new Map(observations.map((item) => [`${item.turnId}:${item.callId}`, item]));
  return records.map(record => {
    let result = resultView(record.return.text);
    const observation = byCall.get(`${record.turnId}:${record.callId}`);
    if (observation && record.return.stage === "complete") {
      result = { ok: true, pageObservationId: observation.id };
    }
    return {
      callId: record.callId,
      turnId: record.turnId,
      batchId: record.batchId,
      name: record.name,
      arguments: { ...record.arguments },
      return: { stage: record.return.stage, result },
    };
  });
}
