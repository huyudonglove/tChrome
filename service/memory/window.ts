import type { Memories } from "./types.ts";

/** Select content only. Runtime owns coverage; projection never clips or prunes records. */
export function projectMemories(memories: Memories): Record<keyof Memories, string> {
  return {
    project: JSON.stringify(memories.project.map(item => item.text), null, 2),
    conversation: JSON.stringify(memories.conversation.map(item => item.text), null, 2),
  };
}
