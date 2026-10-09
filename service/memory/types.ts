export type MemoryLayer = "conversation" | "project";

/** Task event that retires a memory. Written by the model, judged by the runtime. */
export type ExpiryTrigger = "task_complete" | "item_done" | "task_cancelled";

/** Structured reference to the task event that should delete this memory. itemId is required for item_done. */
export type ExpiryCondition = {
  taskId: string;
  itemId?: string;
  on: ExpiryTrigger;
};

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
  /** Retire this record once any condition is met; written from the write call's parallel array. */
  expiresWhen?: ExpiryCondition[];
};

export type MemoryIds = Record<MemoryLayer, string[]>;
export type Memories = Record<MemoryLayer, MemoryRecord[]>;
