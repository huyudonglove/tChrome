import { modelSpeech } from "../../../shared/errors.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "../../types.ts";
import { unwrapStringArrayField } from "../../tools/arguments.ts";
import { querySystemFromModules } from "./context/loader.ts";
import { requestToolResult } from "../tool-agent/index.ts";

export type QueryCandidate = { loopId: string; records: Record<string, unknown>[]; recordKeys?: string[] };
export type QueryRequestPayload = { sumId?: string; loopId?: string; module: string; intent: string; file?: string };
export type QueryMatchResult = { loopIds: string[]; recordKeys?: string[] };

export const QUERY_FORMAT_ATTEMPTS = 3;

/** Layered query System: context/modules.json + overview.md + system/*.md */
export function querySystemPrompt(repoRoot: string): string {
  return querySystemFromModules(repoRoot);
}

/** User: XML tag only; field semantics live in System <queryModules>. */
export function queryUserPrompt(request: QueryRequestPayload, loops: QueryCandidate[]): string {
  return `<queryLoops>\n${JSON.stringify({ request, loops })}\n</queryLoops>`;
}

/** Extract {request, loops} from <queryLoops> payload (raw JSON inside the tag). */
export function queryLoopsFromUserMessage(content: string): { request: QueryRequestPayload; loops: QueryCandidate[] } {
  const normalized = content.replaceAll("\r\n", "\n").trim();
  const match = normalized.match(/^<queryLoops>\n([\s\S]*?)\n<\/queryLoops>$/);
  return JSON.parse((match?.[1] ?? normalized).trim()) as { request: QueryRequestPayload; loops: QueryCandidate[] };
}

export function queryRepairInstruction(allowedIds: string[], fault: string): string {
  const ids = JSON.stringify(allowedIds);
  if (fault.includes("候选范围外") || fault.includes("无效或候选")) {
    return `上一次 loopIds 超出候选。只能从这些 loopId 里选：${ids}。无匹配时交空数组。请修正后，在这一次回包里只调一次 submitMatches。`;
  }
  if (fault.includes("不符合 schema")) {
    return `上一次 loopIds 格式无效。loopIds 必须是字符串数组，不是字符串。只能含候选 ${ids}，无匹配时为空数组。请修正后，在这一次回包里只调一次 submitMatches。`;
  }
  return `上一次 submitMatches 无效。请看 fault。请在这一次回包里只调一次 submitMatches，把 {loopIds: string[]} 一次交齐；只含候选 ${ids}，无匹配时为空数组。`;
}

// The request is semantic. Candidate identities come exclusively from the runtime archive.
export async function requestMatches(input: {
  provider: Provider; repoRoot: string;
  request: QueryRequestPayload;
  candidates: QueryCandidate[];
}): Promise<QueryMatchResult> {
  const allowed = new Set(input.candidates.map(entry => entry.loopId));
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
        unwrapStringArrayField(value, "loopIds");
        return value;
      },
      repairInstruction: fault => queryRepairInstruction([...allowed], fault),
      validateResult: value => {
        const ids = value.loopIds;
        if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !allowed.has(id))) {
          return "Query Agent 返回了无效或候选范围外的 ID。";
        }
        if (value.recordKeys !== undefined && (!Array.isArray(value.recordKeys)
          || value.recordKeys.some(key => typeof key !== "string" || !input.candidates.some(candidate => candidate.recordKeys?.includes(key))))) {
          return "Query Agent 返回了无效或候选范围外的 recordKey。";
        }
        return null;
      },
    },
  });
  return {
    loopIds: [...new Set(result.loopIds as string[])],
    recordKeys: Array.isArray(result.recordKeys) ? [...new Set(result.recordKeys as string[])] : undefined,
  };
}
