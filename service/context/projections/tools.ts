import type { Observation, ToolIOItem } from "../../types.ts";

function resultView(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

/** Content lives in turn modules; toolIO keeps only the pointer's result half. */
const MODULE_POINTERS: Record<string, (args: Record<string, unknown>, result: unknown) => unknown> = {
  finishTurn: () => ({ ok: true, output: "reply" }),
  askUser: () => ({ ok: true, output: "ask" }),
  "notes_write": (args) => ({ ok: true, note: String(args.key ?? "") }),
  "notes_delete": (args) => ({ ok: true, note: String(args.key ?? ""), deleted: true }),
  "memory_writeConversation": () => ({ ok: true, memory: true }),
  "memory_writeProject": () => ({ ok: true, memory: true }),
  "memory_update": (args) => ({ ok: true, memoryId: args.memoryId ?? null }),
  "memory_delete": (args) => ({ ok: true, memoryId: args.memoryId ?? null, deleted: true }),
  "reflect_write": (_args, result) => ({ ok: true, reflectId: (result as { id?: string } | undefined)?.id ?? null }),
  "reflect_delete": (args) => ({ ok: true, reflectId: args.id ?? null, deleted: true }),
  "task_set": () => ({ ok: true, task: true }),
  "task_update": (args) => ({ ok: true, taskId: args.taskId ?? null }),
  "task_complete": (args) => ({ ok: true, taskId: args.taskId ?? null, completed: true }),
  "observation_write": (args) => ({ ok: true, observation: args.type ?? true }),
  "workspace_write": () => ({ ok: true, workspace: true }),
};

/** Page observation payloads live in <observations>; toolIO keeps a pointer only. */
export function toolHistoryView(records: ToolIOItem[], observations: Observation[] = [], ringCallIds?: Set<string>) {
  const byCall = new Map(observations.map((item) => [`${item.turnId}:${item.callId}`, item]));
  // Rolling ring: only the newest calls keep their detail; older rows are omitted
  // entirely (their callIds stay discoverable via each turn's from/to attributes).
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
    } else if (record.name === "context_query" && record.return.stage === "complete"
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
        // toolIO only surfaces the result half; `args` is no longer projected.
        const mapped = pointer(record.arguments as Record<string, unknown>, result);
        const hint = record.return.text.split("\n").find((line) => line.startsWith("runtime:"));
        return {
          callId: record.callId,
          turnId: record.turnId,
          batchId: record.batchId,
          name: record.name,
          return: {
            stage: record.return.stage,
            result: hint && typeof mapped === "object" && mapped !== null && !Array.isArray(mapped)
              ? { ...(mapped as Record<string, unknown>), message: hint }
              : mapped,
          },
        };
      }
    }
    return {
      callId: record.callId,
      turnId: record.turnId,
      batchId: record.batchId,
      name: record.name,
      return: { stage: record.return.stage, result },
    };
  });
}
