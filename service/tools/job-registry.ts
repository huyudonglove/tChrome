import { allocateRecordId, nowIso } from "../runtime/ids.ts";
import { errorInfo } from "../../shared/errors.ts";
import { resolve } from "node:path";

export type JobStatus = "running" | "completed" | "stopped" | "failed";

export type JobEntry = {
  jobId: string;
  scope: string;
  toolName: string;
  status: JobStatus;
  startedAt: string;
  heartbeatSec: number;
  result?: Record<string, unknown>;
  error?: string;
  cancel?: () => void;
};

const jobs = new Map<string, JobEntry>();

export function jobScope(dataDir: string, conversationId: string): string {
  return JSON.stringify([resolve(dataDir), conversationId]);
}

function parseHeartbeatSec(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("heartbeatSec must be a positive integer number of seconds");
  }
  return value;
}

export function snapshotJob(entry: JobEntry): Record<string, unknown> {
  const elapsedMs = Date.now() - Date.parse(entry.startedAt);
  return {
    ok: entry.status === "running" || entry.status === "completed" || entry.status === "stopped",
    jobId: entry.jobId,
    toolName: entry.toolName,
    status: entry.status,
    heartbeatSec: entry.heartbeatSec,
    startedAt: entry.startedAt,
    elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : 0,
    ...(entry.result ? { result: entry.result } : {}),
    ...(entry.error ? { error: entry.error } : {}),
  };
}

export function lookupJob(jobId: unknown, scope: string): JobEntry {
  if (typeof jobId !== "string" || !jobId.trim()) throw new Error("jobId must be a non-empty string");
  const entry = jobs.get(jobId);
  if (!entry || entry.scope !== scope) throw new Error("Job not found in this conversation");
  return entry;
}

export function runJobStatus(input: Record<string, unknown>, scope: string): Record<string, unknown> {
  return snapshotJob(lookupJob(input.jobId, scope));
}

export function runJobStop(input: Record<string, unknown>, scope: string): Record<string, unknown> {
  const entry = lookupJob(input.jobId, scope);
  if (entry.status === "running") {
    try { entry.cancel?.(); }
    catch (error) { entry.error = error instanceof Error ? error.message : String(error); }
    entry.status = "stopped";
  }
  return snapshotJob(entry);
}

export function abortJobsForScope(scope: string): void {
  for (const entry of jobs.values()) {
    if (entry.scope !== scope || entry.status !== "running") continue;
    try { entry.cancel?.(); }
    catch { /* cancel is best-effort during scope teardown */ }
    entry.status = "stopped";
  }
}

export function abortAllJobs(): void {
  for (const entry of jobs.values()) {
    if (entry.status !== "running") continue;
    try { entry.cancel?.(); }
    catch { /* cancel is best-effort during teardown */ }
    entry.status = "stopped";
  }
}

function settleJob(jobId: string, result: Record<string, unknown>): void {
  const entry = jobs.get(jobId);
  if (!entry || entry.status !== "running") return;
  const ok = result.ok !== false;
  entry.status = ok ? "completed" : "failed";
  entry.result = result;
  if (!ok && typeof result.error === "string") entry.error = result.error;
}

function heartbeatReturn(entry: JobEntry): Record<string, unknown> {
  return {
    ok: true,
    heartbeat: true,
    status: "running",
    jobId: entry.jobId,
    toolName: entry.toolName,
    heartbeatSec: entry.heartbeatSec,
    elapsedMs: Date.now() - Date.parse(entry.startedAt),
    note: `仍在执行（已过 ${entry.heartbeatSec}s）。jobId=${entry.jobId}。用 job.status 查询，用 job.stop 结束；任务结束后心跳销毁。`,
  };
}

/** Race a long tool body against heartbeatSec; omit heartbeatSec to wait until completion. */
export async function withJobHeartbeat(options: {
  dataDir: string;
  scope: string;
  toolName: string;
  heartbeatSec: unknown;
  start: (signal?: AbortSignal) => Promise<Record<string, unknown>>;
  parentSignal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  if (options.heartbeatSec === undefined) return options.start(options.parentSignal);
  if (!options.scope) throw new Error("heartbeat requires a conversation scope");
  const heartbeatSec = parseHeartbeatSec(options.heartbeatSec);
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  options.parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  if (options.parentSignal?.aborted) controller.abort();
  const entry: JobEntry = {
    jobId: allocateRecordId(options.dataDir, null, "job"),
    scope: options.scope,
    toolName: options.toolName,
    status: "running",
    startedAt: nowIso(),
    heartbeatSec,
    cancel: () => controller.abort(),
  };
  jobs.set(entry.jobId, entry);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = options.start(controller.signal).then(
    (value) => ({ kind: "done" as const, value }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  );
  const tick = new Promise<{ kind: "heartbeat" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "heartbeat" }), heartbeatSec * 1000);
  });
  try {
    const raced = await Promise.race([started, tick]);
    if (timer) clearTimeout(timer);
    if (raced.kind === "heartbeat") {
      if (entry.status !== "running") return snapshotJob(entry);
      void started.then((outcome) => {
        if (outcome.kind === "done") settleJob(entry.jobId, outcome.value);
        else if (entry.status === "running") {
          entry.status = "failed";
          entry.error = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        }
      });
      return heartbeatReturn(entry);
    }
    if (raced.kind === "done") {
      settleJob(entry.jobId, raced.value);
      return raced.value;
    }
    if (entry.status === "stopped") return snapshotJob(entry);
    entry.status = "failed";
    entry.error = raced.error instanceof Error ? raced.error.message : String(raced.error);
    return { ok: false, jobId: entry.jobId, toolName: entry.toolName, ...errorInfo(raced.error), error: entry.error };
  } finally {
    if (timer) clearTimeout(timer);
    options.parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

export const JOB_TOOL_NAMES = ["job.status", "job.stop"] as const;

export async function runJobTool(name: string, rawInput: unknown, scope: string): Promise<Record<string, unknown>> {
  try {
    if (!scope) throw new Error("Job tools require a conversation scope");
    const input = (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput : {}) as Record<string, unknown>;
    if (name === "job.status") return runJobStatus(input, scope);
    if (name === "job.stop") return runJobStop(input, scope);
    throw new Error(`Unknown job tool: ${name}`);
  } catch (error) {
    return { ok: false, ...errorInfo(error), error: error instanceof Error ? error.message : String(error) };
  }
}
