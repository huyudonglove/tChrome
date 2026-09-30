import type { Observation, ToolIOItem } from "../../types.ts";

function resultView(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

/** Content lives in turn modules; toolIO keeps only the pointer. */
const MODULE_POINTERS: Record<string, (args: Record<string, unknown>, result: unknown) => { args: Record<string, unknown>; result: unknown }> = {
  finishTurn: () => ({ args: { output: "reply" }, result: { ok: true, output: "reply" } }),
  askUser: () => ({ args: { output: "ask" }, result: { ok: true, output: "ask" } }),
  "notes.write": (args) => {
    const key = String(args.key ?? "");
    return { args: { notes: key }, result: { ok: true, note: key } };
  },
  "notes.delete": (args) => {
    const key = String(args.key ?? "");
    return { args: { notes: key, deleted: true }, result: { ok: true, note: key, deleted: true } };
  },
  "memory.write": () => ({ args: { memory: true }, result: { ok: true, memory: true } }),
  "memory.update": (args) => ({ args: { memory: args.memoryId ?? true }, result: { ok: true, memoryId: args.memoryId ?? null } }),
  "memory.delete": (args) => ({ args: { memory: args.memoryId ?? true, deleted: true }, result: { ok: true, memoryId: args.memoryId ?? null, deleted: true } }),
  "reflect.write": (_args, result) => {
    const id = (result as { id?: string } | undefined)?.id;
    return { args: { reflect: id ?? true }, result: { ok: true, reflectId: id ?? null } };
  },
  "reflect.delete": (args) => ({ args: { reflect: args.id ?? true, deleted: true }, result: { ok: true, reflectId: args.id ?? null, deleted: true } }),
  "task.set": () => ({ args: { task: true }, result: { ok: true, task: true } }),
  "task.update": (args) => ({ args: { task: args.taskId ?? true }, result: { ok: true, taskId: args.taskId ?? null } }),
  "task.complete": (args) => ({ args: { task: args.taskId ?? true }, result: { ok: true, taskId: args.taskId ?? null, completed: true } }),
  "observation.write": (args) => ({ args: { observations: args.type ?? true }, result: { ok: true, observation: args.type ?? true } }),
  "actions.write": (args) => ({ args: { actions: true }, result: { ok: true, action: true } }),
};

/** Page observation payloads live in <observations>; toolIO keeps a pointer only. */
export function toolHistoryView(records: ToolIOItem[], observations: Observation[] = [], ringCallIds?: Set<string>) {
  const byCall = new Map(observations.map((item) => [`${item.turnId}:${item.callId}`, item]));
  // Rolling ring: only the newest calls keep their detail; older rows are omitted
  // entirely (their callIds stay discoverable via each turn's callRange).
  const visible = ringCallIds ? records.filter((record) => ringCallIds.has(record.callId)) : records;
  return visible.map(record => {
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
          observationId: observation.id,
          ...(obsRes.faultCode ? { faultCode: obsRes.faultCode } : {}),
          ...(obsRes.message ? { message: obsRes.message } : {}),
          ...(obsRes.recovery ? { recovery: obsRes.recovery } : {}),
          ...(obsRes.details ? { details: obsRes.details } : {}),
        };
      } else {
        result = { ok: true, observationId: observation.id };
      }
    } else if (record.name === "context.query" && record.return.stage === "complete"
      && result && typeof result === "object" && !Array.isArray(result)) {
      // Query originals live in <query>; keep toolIO as a pointer like page observations.
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
    } else if (record.return.stage === "complete") {
      const pointer = MODULE_POINTERS[record.name];
      const failed = result && typeof result === "object" && !Array.isArray(result) && (result as { ok?: unknown }).ok === false;
      if (pointer && !failed) {
        const mapped = pointer(record.arguments as Record<string, unknown>, result);
        const hint = record.return.text.split("\n").find((line) => line.startsWith("runtime:"));
        return {
          callId: record.callId,
          turnId: record.turnId,
          batchId: record.batchId,
          name: record.name,
          arguments: mapped.args,
          return: {
            stage: record.return.stage,
            result: hint ? { ...mapped.result, message: hint } : mapped.result,
          },
        };
      }
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
