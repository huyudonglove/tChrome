export type MemoryLayer = "conversation" | "project";

export type MemoryRecord = {
  memoryId: string;
  turnId: string;
  layer: MemoryLayer;
  text: string;
  summary: string;
  compressed: boolean;
  createdAt: string;
  sourceCallId: string;
  sourceConversationId?: string;
};

export type MemoryIds = Record<MemoryLayer, string[]>;
export type Memories = Record<MemoryLayer, MemoryRecord[]>;
