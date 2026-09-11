import { createHash } from "node:crypto";
import type { Ledger, Turn } from "../types.ts";
import type { Memories } from "../memory/types.ts";
import { loadIndex } from "../compression/store.ts";
import { compressRecords } from "../compression/compress.ts";
import type { Provider } from "../types.ts";

export const COMPRESSION_MODULES = ["userInputHistory", "pageObservedHistory", "conversationMemory", "toolIO"] as const;
export type CompressionModule = typeof COMPRESSION_MODULES[number];
const toolId = (row: Ledger["toolIO"][number], index: number) => `tool_${createHash("sha256").update(JSON.stringify([row.turnId, index, row.callId])).digest("hex")}`;

/** Only the sent view is filtered. Persistent ledgers and memory indexes remain complete. */
export function contextState(dataDir: string, ledger: Ledger, turn: Turn, memories: Memories) {
  const indexes = Object.fromEntries(COMPRESSION_MODULES.map(module => [module, loadIndex(dataDir, ledger.conversationId, module)])) as Record<CompressionModule, ReturnType<typeof loadIndex>>;
  const unseen = (module: CompressionModule, id: string) => !indexes[module].coveredSourceIds.includes(id);
  const tools = ledger.toolIO.map((row, index) => ({ id: toolId(row, index), content: row })).filter(row => unseen("toolIO", row.id));
  const inputHistory = ledger.userInputHistory.filter(row => unseen("userInputHistory", row.id));
  const pages = turn.assembled.pageObservedHistory.filter(row => unseen("pageObservedHistory", row.id));
  const memory = memories.conversation.filter(row => unseen("conversationMemory", row.memoryId));
  const summaries = Object.fromEntries(COMPRESSION_MODULES.map(module => [module, indexes[module].activeIds.map(id => {
    const entry = indexes[module].entries.find(row => row.id === id);
    if (!entry) throw new Error(`Missing active compression record: ${id}`);
    return { tag: entry.tag, summary: entry.summary };
  })]));
  const batches = [...new Set(tools.map(row => row.content.batchId ?? row.content.turnId))];
  const recentBatches = new Set(batches.slice(-2));
  const candidates = {
    userInputHistory: inputHistory.slice(0, -3).map(row => ({ id: row.id, content: row })),
    pageObservedHistory: pages.slice(0, -3).map(row => ({ id: row.id, content: row })),
    conversationMemory: memory.slice(0, -3).map(row => ({ id: row.memoryId, content: row })),
    toolIO: tools.filter(row => !recentBatches.has(row.content.batchId ?? row.content.turnId)),
  };
  return {
    ledger: { ...ledger, userInputHistory: inputHistory, toolIO: tools.map(row => row.content) },
    turn: { ...turn, assembled: { ...turn.assembled, pageObservedHistory: pages } },
    memories: { ...memories, conversation: memory }, summaries, candidates,
  };
}

export async function compressContext(input: { dataDir: string; repoRoot: string; provider: Provider; ledger: Ledger; turn: Turn; memories: Memories; isCancelled: () => boolean }) {
  const state = contextState(input.dataDir, input.ledger, input.turn, input.memories);
  for (const module of COMPRESSION_MODULES) {
    if (input.isCancelled()) throw new Error("compression_cancelled");
    await compressRecords({ ...input, conversationId: input.ledger.conversationId, module, records: state.candidates[module] });
  }
}
