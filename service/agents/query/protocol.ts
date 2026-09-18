import { AppError } from "../../../shared/errors.ts";
import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage, ChatTool, CompletionResult, Provider } from "../../types.ts";
import { querySystemFromModules } from "./context/loader.ts";

export type QueryCandidate = { turnId: string; records: Record<string, unknown>[] };
export type QueryRequestPayload = { sumId: string; module: string; intent: string };

export const QUERY_FORMAT_ATTEMPTS = 3;

/** Layered query System: context/modules.json + overview.md + system/*.md */
export function querySystemPrompt(repoRoot: string): string {
  return querySystemFromModules(repoRoot);
}

/** User: XML tag only; field semantics live in System <queryModules>. */
export function queryUserPrompt(request: QueryRequestPayload, turns: QueryCandidate[]): string {
  return `<queryTurns>\n${JSON.stringify({ request, turns })}\n</queryTurns>`;
}

/** Extract {request, turns} from <queryTurns> payload (raw JSON inside the tag). */
export function queryTurnsFromUserMessage(content: string): { request: QueryRequestPayload; turns: QueryCandidate[] } {
  const normalized = content.replaceAll("\r\n", "\n").trim();
  const match = normalized.match(/^<queryTurns>\n([\s\S]*?)\n<\/queryTurns>$/);
  return JSON.parse((match?.[1] ?? normalized).trim()) as { request: QueryRequestPayload; turns: QueryCandidate[] };
}

// The request is semantic. Candidate identities come exclusively from the runtime archive.
export async function requestMatches(input: {
  provider: Provider; repoRoot: string;
  request: QueryRequestPayload;
  candidates: QueryCandidate[];
}): Promise<string[]> {
  const system = querySystemPrompt(input.repoRoot);
  const tool: ChatTool = JSON.parse(readFileSync(join(input.repoRoot, "service/agents/query/tools/submit-matches.json"), "utf8"));
  const validate = new Ajv({ allErrors: true, strict: false }).compile(tool.function.parameters);
  const allowed = new Set(input.candidates.map(entry => entry.turnId));
  const baseMessages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: queryUserPrompt(input.request, input.candidates) },
  ];
  let lastError = "";
  const protocolFault = (response: CompletionResult): string | null => {
    if (response.finish === "error" && response.faultCode) return null;
    if (response.finish !== "tool_calls" || response.toolCalls.length !== 1 || response.faultCode
      || !response.parseOk || !response.schemaOk || response.toolCallFaults?.length || response.missing.length) {
      return response.detail || response.faultCode || "invalid_return_tool_call";
    }
    const call = response.toolCalls[0]!;
    if (call.name !== "submitMatches" || typeof call.id !== "string" || !call.id.trim()) {
      return "查询 Agent 必须通过一次 submitMatches 工具调用返回结果。";
    }
    return null;
  };
  for (let attempt = 1; attempt <= QUERY_FORMAT_ATTEMPTS; attempt++) {
    const messages: ChatMessage[] = attempt === 1 ? baseMessages : [
      ...baseMessages,
      {
        role: "user",
        content: JSON.stringify({
          selfRepair: true,
          attempt,
          maxAttempts: QUERY_FORMAT_ATTEMPTS,
          fault: lastError,
          instruction: "上一次 submitMatches 格式无效。请在这一次回包里只调一次 submitMatches，把 {turnIds: string[]} 一次交齐；只含本次候选 turnId，无匹配时为空数组。",
        }),
      },
    ];
    const response = await input.provider.complete({ tools: [tool], messages });
    if (response.finish === "error" && response.faultCode) {
      throw new AppError(response.faultCode, `Query agent failed: ${response.faultCode}`);
    }
    const fault = protocolFault(response);
    if (fault) {
      lastError = fault;
      if (attempt === QUERY_FORMAT_ATTEMPTS) throw new AppError("query_failed", `Query agent format failed after ${QUERY_FORMAT_ATTEMPTS} attempts: ${fault}`);
      continue;
    }
    const call = response.toolCalls[0]!;
    const value = call.arguments;
    if (!validate(value)) {
      lastError = "查询 Agent 返回的工具参数不符合 schema。";
      if (attempt === QUERY_FORMAT_ATTEMPTS) throw new AppError("query_failed", lastError);
      continue;
    }
    if ((value.turnIds as string[]).some(id => !allowed.has(id))) {
      lastError = "查询 Agent 返回了无效或候选范围外的 turnId。";
      if (attempt === QUERY_FORMAT_ATTEMPTS) throw new AppError("query_failed", lastError);
      continue;
    }
    return [...new Set(value.turnIds as string[])];
  }
  throw new AppError("query_failed", `Query agent format failed after ${QUERY_FORMAT_ATTEMPTS} attempts: ${lastError}`);
}
