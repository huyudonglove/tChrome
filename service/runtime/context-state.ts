import { runtimeConfig } from "../config/runtime.ts";
import type { Ledger, Turn, Provider } from "../types.ts";
import type { Memories } from "../memory/types.ts";
import { loadIndex } from "../context-archive/store.ts";
import { compressRecords, type CompressOutcome, type CompressProgress } from "../agents/compression/index.ts";

export const HISTORY_MODULE = "conversationHistory" as const;

/** Projection only: immutable loop records remain available for source retrieval. */
export function contextState(dataDir: string, ledger: Ledger, turn: Turn, memories: Memories) {
  const index = loadIndex(dataDir, ledger.conversationId, HISTORY_MODULE);
  const covered = new Set(index.coveredSourceIds);
  const coveredCalls = new Set(ledger.loops.filter(loop => covered.has(loop.id)).flatMap(loop => loop.helm?.calls.map(call => call.id) ?? []));
  const entries = new Map(index.entries.map(entry => [entry.id, entry]));
  const order = new Map(ledger.loops.map((loop, position) => [loop.id, position]));
  const summaries = index.activeIds.map(id => {
    const entry = entries.get(id);
    if (!entry) throw new Error(`Missing active loop summary: ${id}`);
    return entry;
  }).sort((a, b) => (order.get(a.loopIds[0]!) ?? Infinity) - (order.get(b.loopIds[0]!) ?? Infinity));
  return {
    ledger: { ...ledger, loops: ledger.loops.filter(loop => !covered.has(loop.id)) },
    turn,
    memories: { ...memories, conversation: memories.conversation.filter(row => !coveredCalls.has(row.sourceCallId)) },
    summaries,
  };
}

type CompressionInput = { dataDir: string; repoRoot: string; provider: Provider; ledger: Ledger; turn: Turn; memories: Memories; isCancelled: () => boolean; onStart?: () => void; onProgress?: (event: CompressProgress) => void };

/** The newest loop is always retained. Every other uncovered loop is an indivisible source. */
export async function compressContext(input: CompressionInput): Promise<CompressOutcome> {
  if (input.isCancelled()) throw new Error("compression_cancelled");
  const index = loadIndex(input.dataDir, input.ledger.conversationId, HISTORY_MODULE);
  const covered = new Set(index.coveredSourceIds);
  const records = input.ledger.loops.slice(0, -runtimeConfig.context.keepLoops).filter(loop => !covered.has(loop.id)).map(loop => ({ id: loop.id, content: loop }));
  if (!records.length) return { status: "noop", committedLoopIds: [], totalLoops: 0 };
  input.onStart?.();
  return compressRecords({ ...input, conversationId: input.ledger.conversationId, module: HISTORY_MODULE, records });
}
