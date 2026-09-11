import type { Memories, MemoryRecord } from "./types.ts";

/** Preserve identity and content. Runtime owns coverage; projection never prunes records. */
export function projectMemories(memories: Memories): Record<keyof Memories, string> {
  return {
    project: JSON.stringify(memories.project.map(memoryView), null, 2),
    conversation: JSON.stringify(memories.conversation.map(memoryView), null, 2),
  };
}

const memoryView = ({ memoryId, turnId, sourceCallId, sourceConversationId, text }: MemoryRecord) => ({ memoryId, turnId, sourceCallId, sourceConversationId, text });
