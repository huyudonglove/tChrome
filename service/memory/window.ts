import type { Memories, MemoryRecord } from "./types.ts";

export const MEMORY_WINDOW = 8;

const memoryBody = (items: MemoryRecord[], compact = false) => JSON.stringify(items
  .slice(-MEMORY_WINDOW)
  .map(item => ({
    id: item.memoryId,
    text: compact ? (item.summary || item.text.replace(/\s+/g, " ").trim().slice(0, 80)) : item.compressed ? item.summary : item.text,
    sourceCallId: item.sourceCallId,
    createdAt: item.createdAt,
    ...(item.sourceConversationId ? { sourceConversationId: item.sourceConversationId } : {}),
  })), null, 2);

/** Projection is read-only: never prune indexes or overwrite stored memory. */
export function projectMemories(memories: Memories, compact = false): Record<keyof Memories, string> {
  return {
    project: memoryBody(memories.project),
    conversation: memoryBody(memories.conversation, compact),
  };
}
