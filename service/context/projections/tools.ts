import type { PageObservation, ToolIOItem } from "../../types.ts";

function resultView(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

/** Page observation payloads live in <pageObservedHistory>; toolIO keeps a pointer only. */
export function toolHistoryView(records: ToolIOItem[], observations: PageObservation[] = []) {
  const byCall = new Map(observations.map((item) => [`${item.turnId}:${item.callId}`, item]));
  return records.map(record => {
    let result = resultView(record.return.text);
    const observation = byCall.get(`${record.turnId}:${record.callId}`);
    if (observation && record.return.stage === "complete") {
      const obsRes = observation.result && typeof observation.result === "object"
        ? (observation.result as Record<string, unknown>)
        : null;
      const observedOk = obsRes && "ok" in obsRes
        ? Boolean(obsRes.ok)
        : true;
      if (!observedOk && obsRes) {
        result = {
          ok: false,
          pageObservationId: observation.id,
          ...(obsRes.faultCode ? { faultCode: obsRes.faultCode } : {}),
          ...(obsRes.message ? { message: obsRes.message } : {}),
          ...(obsRes.recovery ? { recovery: obsRes.recovery } : {}),
          ...(obsRes.details ? { details: obsRes.details } : {}),
        };
      } else {
        result = { ok: true, pageObservationId: observation.id };
      }
    } else if (record.name === "context.query" && record.return.stage === "complete"
      && result && typeof result === "object" && !Array.isArray(result)) {
      // Query originals live in <currentQuery>; keep toolIO as a pointer like page observations.
      const query = result as Record<string, unknown>;
      const records = Array.isArray(query.records) ? query.records : [];
      result = {
        ok: query.ok ?? true,
        status: query.status,
        sumId: query.sumId,
        module: query.module,
        intent: query.intent,
        currentQuery: true,
        recordCount: records.length,
        ...(query.faultCode ? { faultCode: query.faultCode } : {}),
        ...(query.detail ? { detail: query.detail } : {}),
      };
    }
    const args = record.name === "finishTurn"
      ? { text: typeof (record.arguments as { text?: unknown }).text === "string" ? (record.arguments as { text: string }).text : "" }
      : { ...record.arguments };
    const finalResult = record.name === "finishTurn" && record.return.stage === "complete" && typeof result === "string"
      ? (result === (args as { text: string }).text ? { ok: true, replied: true } : result)
      : result;
    return {
      callId: record.callId,
      turnId: record.turnId,
      batchId: record.batchId,
      name: record.name,
      arguments: args,
      return: { stage: record.return.stage, result: finalResult },
    };
  });
}
