export type MemoryLayer = "conversation" | "project";

export type MemoryRecord = {
  memoryId: string;
  turnId: string;
  layer: MemoryLayer;
  /** Ownership key: which project this belongs to. Absent on pre-scope records, which read as global. */
  scope?: string;
  /** One-line gist shown in the per-scope index; falls back to the first sentence of text. */
  summary?: string;
  text: string;
  createdAt: string;
  sourceCallId: string;
  sourceConversationId?: string;
};

export type MemoryIds = Record<MemoryLayer, string[]>;
export type Memories = Record<MemoryLayer, MemoryRecord[]>;
