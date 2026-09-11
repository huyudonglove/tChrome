import type { Provider } from "../types.ts";
import { runJsonAgent } from "./agent.ts";
import { loadIndex, resolveSources } from "./store.ts";
import type { CompressionModule } from "./types.ts";

const MODULES = ["userInputHistory", "pageObservedHistory", "conversationMemory", "toolIO"];
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

/** Omit storage linkage only. Page target refs and complete content are preserved. */
function contentForModel(content: unknown): unknown {
  if (!content || typeof content !== "object" || Array.isArray(content)) return content;
  const hidden = new Set(["id", "memoryId", "turnId", "sourceCallId", "callId", "batchId", "createdAt"]);
  return Object.fromEntries(Object.entries(content).filter(([key]) => !hidden.has(key)));
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
    const chunks: { id: string; tag: string; summary: string; level: number; createdAt: string }[][] = [];
    let chunk: typeof chunks[number] = [], size = 2;
    for (const entry of index.entries) {
      const item = { id: entry.id, tag: entry.tag, summary: entry.summary, level: entry.level, createdAt: entry.createdAt };
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
      const result = await runJsonAgent({ provider: input.provider, repoRoot: input.repoRoot,
        promptNames: ["query-role.md", "query-match.md"],
        payload: { module: input.module, tag: input.tag, question: input.question ?? "", entries } });
      if (input.isCancelled?.()) return cancelled();
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("查询 Agent 返回格式无效。");
      const fields = result as Record<string, unknown>;
      const allowed = new Set(entries.map(entry => entry.id));
      if (Object.keys(fields).some(key => key !== "ids") || !Array.isArray(fields.ids)
        || fields.ids.some(id => typeof id !== "string" || !allowed.has(id))) throw new Error("查询 Agent 返回了无效或目录外的 ID。");
      for (const id of fields.ids as string[]) selected.add(id);
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
      ...(omittedRecords ? { detail: "匹配原文超过单次 30000 字符上限，未截断任何原文。请缩小 tag 或 question 后重查；单条原文过大时本次无法返回。" } : {}) };
  } catch (error) {
    return { ...base, ok: false, status: "error", detail: error instanceof Error ? error.message : "归档查询失败。" };
  }
}
