import { AppError } from "../../../shared/errors.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { compressionLog } from "./log.ts";
import { compressionSystemFromModules } from "./context/loader.ts";
import type { ChatTool, LoopRecord, Provider } from "../../types.ts";

import type { SummaryFields } from "../../context-archive/types.ts";

export type LoopSummary = SummaryFields & { loopIds: string[] };
export type SubmittedSummaryFields = SummaryFields;
export type FoldRow = LoopSummary;
export function compressionSystemPrompt(repoRoot: string): string { return compressionSystemFromModules(repoRoot); }
export function compressionUserPrompt(_repoRoot: string, loops: LoopRecord[]): string {
  return `<compressionLoops>\n${JSON.stringify({ loops })}\n</compressionLoops>`;
}
export function compressionLoopsFromUserMessage(content: string): LoopRecord[] {
  const match = content.trim().match(/^<compressionLoops>\n([\s\S]*?)\n<\/compressionLoops>$/);
  if (!match) throw new Error("Invalid compressionLoops payload");
  return (JSON.parse(match[1]!) as { loops: LoopRecord[] }).loops;
}
/** 子代理偶尔在形状上漂移：该给数组的地方给了字符串，该给文本的地方给了对象行
 * （{decision, reason, …}）。校验前先归一这两种漂移，避免一个字段漂移就整批丢弃；
 * 真正非法的值仍然会被拒绝。 */
const SUMMARY_ROW_KEYS = ["text", "value", "decision", "reason", "fallback", "note", "summary"] as const;
function summaryText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}
function summaryList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  const out: string[] = [];
  for (const item of Array.isArray(value) ? value : [value]) {
    if (typeof item === "string") {
      const text = item.trim();
      if (!text) return null;
      out.push(text);
      continue;
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const row = item as Record<string, unknown>;
      const parts = SUMMARY_ROW_KEYS.map(key => summaryText(row[key])).filter((text): text is string => text !== null);
      if (!parts.length) return null;
      out.push(parts.join("；"));
      continue;
    }
    return null;
  }
  return out;
}
export function normalizeSummaryFields(raw: unknown): SubmittedSummaryFields | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const userRequest = summaryText(value.userRequest);
  const state = summaryText(value.state);
  const constraints = summaryList(value.constraints);
  const pending = summaryList(value.pending);
  const decisions = summaryList(value.decisions);
  if (!userRequest || !state || !constraints || !pending || !decisions) return null;
  return { userRequest, state, constraints, pending, decisions };
}

async function submit(input: { provider: Provider; repoRoot: string; dataDir: string; conversationId: string; user: string; single: boolean }): Promise<SubmittedSummaryFields[]> {
  const log = compressionLog(input.dataDir, input.conversationId);
  const append = (stage: string, data: unknown) => { try { log.append(stage, data); } catch { /* diagnostic only */ } };
  const tool = JSON.parse(readFileSync(join(input.repoRoot, "service/agents/compression/tools/submit-loop-summaries.json"), "utf8")) as ChatTool;
  const validate = new Ajv({ allErrors: true }).compile(tool.function.parameters);
  const request = { tools: [tool], messages: [{ role: "system" as const, content: compressionSystemPrompt(input.repoRoot) }, { role: "user" as const, content: input.user }] };
  append("request", request);
  const response = await input.provider.complete(request);
  append("response", response);
  if (response.faultCode) throw new AppError(response.faultCode, response.detail || "Compression provider failed");
  if (response.finish !== "tool_calls" || response.faultCode || !response.parseOk || !response.schemaOk || response.missing.length || response.toolCallFaults?.length || !response.toolCalls.length || (input.single && response.toolCalls.length !== 1)) throw new Error("Invalid compression response");
  const result: SubmittedSummaryFields[] = [];
  for (const call of response.toolCalls) {
    if (!call.id?.trim() || call.name !== tool.function.name) throw new Error("Invalid compression submission: unrecognized tool call");
    const value = normalizeSummaryFields(call.arguments);
    if (!value) throw new Error(`Invalid compression submission: ${JSON.stringify(call.arguments)}`);
    if (!validate(value)) throw new Error(`Invalid compression submission: ${JSON.stringify(validate.errors)}`);
    result.push(value);
  }
  return result;
}
/** One batch, one request, one response. Every submission must validate before any source is covered. */
export async function requestLoopSummaries(input: { provider: Provider; repoRoot: string; loops: LoopRecord[]; dataDir: string; conversationId: string; module?: string }): Promise<LoopSummary[]> {
  if (!input.loops.length || input.loops.some(loop => !loop.id?.trim())) throw new Error("Missing compression loop identity");
  const values = await submit({ ...input, user: compressionUserPrompt(input.repoRoot, input.loops), single: false });
  return values.map(value => ({ ...value, loopIds: input.loops.map(loop => loop.id) }));
}
export async function requestLoopFold(input: { provider: Provider; repoRoot: string; level: number; loopIds: string[]; rows: FoldRow[]; dataDir: string; conversationId: string; module?: string }): Promise<LoopSummary> {
  const values = await submit({ ...input, single: true, user: `<summaryFold>\n${JSON.stringify({ level: input.level, loopIds: input.loopIds, summaries: input.rows })}\n</summaryFold>` });
  return { ...values[0]!, loopIds: [...input.loopIds] };
}
