import type { CompletionResult, Ledger, LoopRecord, LoopToolResult, RuntimeRecord, ToolIOItem } from "../types.ts";
import { allocateRecordId, nowIso } from "./ids.ts";
import { resolveKeepInCalls } from "../tools/capability.ts";

/** An unsent input envelope can accumulate results and user messages before its request. */
export function inputLoop(dataDir: string, ledger: Ledger, turnId: string): LoopRecord {
  const last = ledger.loops.at(-1);
  if (last && !last.sentAt && !last.completedAt) return last;
  const loop: LoopRecord = {
    id: allocateRecordId(dataDir, ledger.conversationId, "loop"),
    conversationId: ledger.conversationId, turnId, createdAt: nowIso(), runtime: [],
  };
  ledger.loops.push(loop);
  return loop;
}

export function appendRuntime(dataDir: string, ledger: Ledger, turnId: string, type: RuntimeRecord["type"], content: unknown): RuntimeRecord {
  const record: RuntimeRecord = {
    id: allocateRecordId(dataDir, ledger.conversationId, "runtime"), type, content: structuredClone(content),
  };
  inputLoop(dataDir, ledger, turnId).runtime.push(record);
  return record;
}

/** Notices are recomputed only in the unsent envelope. Published history is immutable. */
export function setLoopNotice(dataDir: string, ledger: Ledger, turnId: string, kind: string, text: string | null): void {
  const loop = inputLoop(dataDir, ledger, turnId);
  const existing = loop.runtime.find(row => row.type === "notice" && (row.content as { kind?: string }).kind === kind);
  if (existing && (existing.content as { text: string }).text === text) return;
  loop.runtime = loop.runtime.filter(row => row !== existing);
  if (text) appendRuntime(dataDir, ledger, turnId, "notice", { kind, scope: "loop", text });
}

export function recordToolResult(dataDir: string, ledger: Ledger, row: ToolIOItem): void {
  let result: unknown;
  try { result = JSON.parse(row.return.text); } catch { result = row.return.text; }
  const origin = ledger.loops.findLast(loop => loop.helm?.calls.some(call => call.id === row.callId)
    || loop.helm?.toolCallFaults?.some(call => call.callId === row.callId))
    ?? ledger.loops.findLast(loop => loop.helm && loop.turnId === row.turnId);
  const item: LoopToolResult = {
    ...(origin ? { sourceLoopId: origin.id } : {}),
    callId: row.callId, name: row.name, result,
    keepInCalls: resolveKeepInCalls(row.name, row.arguments.keepInCalls),
  };
  for (const prior of ledger.loops) for (const rt of prior.runtime) {
    if (rt.type !== "callsResult") continue;
    const content = rt.content as LoopToolResult[];
    const index = content.findIndex(value => value.callId === row.callId);
    if (index < 0) continue;
    if (JSON.stringify(content[index]!.result) === JSON.stringify(item.result)) return;
    if (!prior.sentAt) { content[index] = structuredClone(item); return; }
  }
  const loop = inputLoop(dataDir, ledger, row.turnId);
  const previous = loop.runtime.at(-1);
  if (previous?.type === "callsResult") (previous.content as LoopToolResult[]).push(structuredClone(item));
  else appendRuntime(dataDir, ledger, row.turnId, "callsResult", [item]);
  for (const text of row.runtimeHints ?? []) appendRuntime(dataDir, ledger, row.turnId, "notice", { kind: "tool", scope: "loop", callId: row.callId, text });
}

export function recordHelm(dataDir: string, ledger: Ledger, loop: LoopRecord, response: CompletionResult): void {
  loop.helm = {
    id: allocateRecordId(dataDir, ledger.conversationId, "helm"), content: response.content,
    calls: structuredClone(response.toolCalls), finish: response.finish,
    faultCode: response.faultCode, parseOk: response.parseOk, schemaOk: response.schemaOk, missing: [...response.missing],
    ...(response.detail ? { detail: response.detail } : {}),
    ...(response.grounding ? { grounding: structuredClone(response.grounding) } : {}),
    ...(response.toolCallFaults ? { toolCallFaults: structuredClone(response.toolCallFaults) } : {}),
  };
  loop.completedAt = nowIso();
}
