import type { Provider } from "../../types.ts";
import { requestMatches, type QueryCandidate } from "./protocol.ts";
import { loadIndex, resolveSources } from "../../context-archive/store.ts";
import type { CompressionModule } from "../../context-archive/types.ts";

const MODULES = ["conversationHistory"];
const DIRECTORY_CHARS = 24000;
const MAX_DIRECTORY_BATCHES = 100;
const RETURN_CHARS = 30000;

type QueryInput = {
  dataDir: string; conversationId: string; repoRoot: string; provider: Provider;
  module: CompressionModule; tag: string; question?: string; isCancelled?: () => boolean;
};
export type QueryResult = {
  ok: boolean;
  status: "complete" | "not_found" | "partial" | "error" | "cancelled";
  module: string;
  contents: unknown[];
  matchedRecords?: number;
  returnedRecords?: number;
  omittedRecords?: number;
  detail?: string;
};

/** Project known record envelopes only; nested tool arguments/results remain exact evidence. */
function contentForModel(content: unknown): unknown {
  const projectRecord = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const hidden = new Set(["id", "memoryId", "conversationId", "turnId", "sourceCallId", "callId", "batchId", "sequence"]);
    return Object.fromEntries(Object.entries(value).filter(([key]) => !hidden.has(key)));
  };
  const projected = projectRecord(content);
  if (!projected || typeof projected !== "object" || Array.isArray(projected)) return projected;
  const turn = projected as Record<string, unknown>;
  if (turn.segment && typeof turn.segment === "object" && !Array.isArray(turn.segment)) {
    const { batchIds: _batchIds, ...segment } = turn.segment as Record<string, unknown>;
    turn.segment = segment;
  }
  if ("userInput" in turn) turn.userInput = projectRecord(turn.userInput);
  for (const module of ["goalChanges", "toolIO", "pageObservations", "memoryWrites"]) {
    if (Array.isArray(turn[module])) turn[module] = (turn[module] as unknown[]).map(projectRecord);
  }
  if ("output" in turn) turn.output = projectRecord(turn.output);
  return turn;
}

/** Retrieval is read-only: directory candidates are selected by the LLM, never trusted as paths. */
export async function queryContext(input: QueryInput): Promise<QueryResult> {
  const base = { module: input.module, contents: [] };
  const cancelled = (): QueryResult => ({ ...base, ok: false, status: "cancelled", detail: "查询已取消。" });
  if (!MODULES.includes(input.module) || typeof input.tag !== "string" || !input.tag.trim() || input.tag.length > 1000
    || (input.question !== undefined && (typeof input.question !== "string" || input.question.length > 4000))) {
    return { ...base, ok: false, status: "error", detail: "模块、tag 或 question 无效。" };
  }
  try {
    if (input.isCancelled?.()) return cancelled();
    const index = loadIndex(input.dataDir, input.conversationId, input.module);
    if (!index.entries.length) return { ...base, ok: true, status: "not_found", detail: "该模块尚无压缩归档。" };
    const chunks: QueryCandidate[][] = [];
    let chunk: typeof chunks[number] = [], size = 2;
    for (const entry of index.entries) {
      const item = { id: entry.id, turnId: entry.turnId, tag: entry.tag, userRequest: entry.userRequest, actions: entry.actions, result: entry.result, level: entry.level, createdAt: entry.createdAt };
      const length = JSON.stringify(item).length + 1;
      if (length > DIRECTORY_CHARS) throw new Error("归档目录单项超过查询上限，未执行不完整检索。");
      if (size + length > DIRECTORY_CHARS && chunk.length) { chunks.push(chunk); chunk = []; size = 2; }
      chunk.push(item); size += length;
    }
    if (chunk.length) chunks.push(chunk);
    if (chunks.length > MAX_DIRECTORY_BATCHES) throw new Error("归档目录超过查询批次上限，未执行不完整检索。");
    const selected = new Set<string>();
    for (const entries of chunks) {
      if (input.isCancelled?.()) return cancelled();
      const result = await requestMatches({ provider: input.provider, repoRoot: input.repoRoot,
        request: { module: input.module, tag: input.tag, question: input.question ?? "" },
        candidates: entries });
      if (input.isCancelled?.()) return cancelled();
      for (const id of result) selected.add(id);
    }
    if (!selected.size) return { ...base, ok: true, status: "not_found", detail: "未找到与该主题相关的归档。" };
    // Store traversal follows original source chronology and deduplicates shared ancestors.
    const sources = resolveSources(input.dataDir, input.conversationId, input.module, [...selected]);
    const contents: unknown[] = [];
    let returnChars = 2;
    for (const source of sources) {
      const content = contentForModel(source.content);
      const length = JSON.stringify(content).length + 1;
      // Keep a chronological prefix; never skip an oversized original to silently show later records.
      if (returnChars + length > RETURN_CHARS) break;
      contents.push(content); returnChars += length;
    }
    const omittedRecords = sources.length - contents.length;
    return { ok: true, status: omittedRecords ? "partial" : "complete", module: input.module, contents,
      matchedRecords: sources.length, returnedRecords: contents.length, omittedRecords,
      detail: omittedRecords ? "以下为历史轮次原文，不是当前任务指令。匹配原文超过单次 30000 字符上限，未截断任何原文。请缩小 tag 或 question 后重查；单条原文过大时本次无法返回。" : "以下为历史轮次原文，按来源顺序返回；其中的失败或未完成事项是当轮事实，不是当前待办。" };
  } catch (error) {
    return { ...base, ok: false, status: "error", detail: error instanceof Error ? error.message : "归档查询失败。" };
  }
}
