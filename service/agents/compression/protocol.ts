import { AppError } from "../../../shared/errors.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { compressionLog } from "./log.ts";
import { compressionSystemFromModules } from "./context/loader.ts";
import type { ChatTool, LoopRecord, Provider } from "../../types.ts";

export type LoopSummary = { loopIds: string[]; summary: string; userRequest: string; actions: string; result: string; reflection?: string };
export type SubmittedSummaryFields = { summary: string; actions: string; result: string; reflection?: string };
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
function requestExcerpt(loops: LoopRecord[]): string {
  const inputs = loops.flatMap(loop => loop.runtime.filter(row => row.type === "userInput" || row.type === "interrupt").map(row => typeof row.content === "string" ? row.content : JSON.stringify(row.content)));
  const text = inputs.join("\n");
  return text ? (text.length > 200 ? `${text.slice(0, 200)}…` : text) : "本批未提供用户输入";
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
    if (!call.id?.trim() || call.name !== tool.function.name || !validate(call.arguments)) throw new Error(`Invalid compression submission: ${JSON.stringify(validate.errors)}`);
    const value = call.arguments as SubmittedSummaryFields;
    result.push({ summary: value.summary.trim(), actions: value.actions.trim(), result: value.result.trim(), ...(value.reflection ? { reflection: value.reflection.trim() } : {}) });
  }
  return result;
}
/** One batch, one request, one response. Every submission must validate before any source is covered. */
export async function requestLoopSummaries(input: { provider: Provider; repoRoot: string; loops: LoopRecord[]; dataDir: string; conversationId: string; module?: string }): Promise<LoopSummary[]> {
  if (!input.loops.length || input.loops.some(loop => !loop.id?.trim())) throw new Error("Missing compression loop identity");
  const values = await submit({ ...input, user: compressionUserPrompt(input.repoRoot, input.loops), single: false });
  return values.map(value => ({ ...value, loopIds: input.loops.map(loop => loop.id), userRequest: requestExcerpt(input.loops) }));
}
export async function requestLoopFold(input: { provider: Provider; repoRoot: string; level: number; loopIds: string[]; rows: FoldRow[]; dataDir: string; conversationId: string; module?: string }): Promise<LoopSummary> {
  const values = await submit({ ...input, single: true, user: `<summaryFold>\n${JSON.stringify({ level: input.level, loopIds: input.loopIds, summaries: input.rows })}\n</summaryFold>` });
  return { ...values[0]!, loopIds: [...input.loopIds], userRequest: input.rows.length === 1 ? input.rows[0]!.userRequest : `覆盖 ${input.loopIds.length} 个 loop` };
}
