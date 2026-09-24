import { modelSpeech } from "../../../shared/errors.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "../../types.ts";
import { unwrapStringArrayField } from "../../tools/arguments.ts";
import { querySystemFromModules } from "./context/loader.ts";
import { requestToolResult } from "../tool-agent/index.ts";

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

export function queryRepairInstruction(allowedIds: string[], fault: string): string {
  const ids = JSON.stringify(allowedIds);
  if (fault.includes("候选范围外") || fault.includes("无效或候选")) {
    return `上一次 turnIds 超出候选。只能从这些 turnId 里选：${ids}。无匹配时交空数组。请修正后，在这一次回包里只调一次 submitMatches。`;
  }
  if (fault.includes("不符合 schema")) {
    return `上一次 turnIds 格式无效。turnIds 必须是字符串数组，不是字符串。只能含候选 ${ids}，无匹配时为空数组。请修正后，在这一次回包里只调一次 submitMatches。`;
  }
  return `上一次 submitMatches 无效。请看 fault。请在这一次回包里只调一次 submitMatches，把 {turnIds: string[]} 一次交齐；只含候选 ${ids}，无匹配时为空数组。`;
}

// The request is semantic. Candidate identities come exclusively from the runtime archive.
export async function requestMatches(input: {
  provider: Provider; repoRoot: string;
  request: QueryRequestPayload;
  candidates: QueryCandidate[];
}): Promise<string[]> {
  const allowed = new Set(input.candidates.map(entry => entry.turnId));
  const result = await requestToolResult({
    provider: input.provider,
    protocol: {
      agentName: "Query Agent",
      faultCode: "query_failed",
      systemPrompt: querySystemPrompt(input.repoRoot),
      userPrompt: queryUserPrompt(input.request, input.candidates),
      tool: JSON.parse(readFileSync(join(input.repoRoot, "service/agents/query/tools/submit-matches.json"), "utf8")),
      toolName: "submitMatches",
      normalizeResult: value => {
        unwrapStringArrayField(value, "turnIds");
        return value;
      },
      repairInstruction: fault => queryRepairInstruction([...allowed], fault),
      validateResult: value => {
        const ids = value.turnIds;
        if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !allowed.has(id))) {
          return "Query Agent 返回了无效或候选范围外的 ID。";
        }
        return null;
      },
    },
  });
  return [...new Set(result.turnIds as string[])];
}
