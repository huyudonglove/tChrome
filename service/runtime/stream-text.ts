export type ModelTextEvent =
  | { type: "reset" }
  | { type: "delta"; text: string }
  | { type: "end" };

type Listener = (event: ModelTextEvent & { conversationId: string }) => void;

/**
 * Ephemeral model-text draft for the active request. Display-only: tool batches
 * still wait for the full CompletionResult before they enter the queue.
 */
export function createModelTextHub() {
  const drafts = new Map<string, string>();
  const listeners = new Set<Listener>();

  const emit = (conversationId: string, event: ModelTextEvent) => {
    const payload = { ...event, conversationId };
    for (const listener of [...listeners]) listener(payload);
  };

  return {
    getText(conversationId: string): string {
      return drafts.get(conversationId) ?? "";
    },
    /** Snapshot of every live draft, used when an SSE client first connects. */
    snapshot(): Record<string, string> {
      return Object.fromEntries(drafts);
    },
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset(conversationId: string) {
      drafts.set(conversationId, "");
      emit(conversationId, { type: "reset" });
    },
    delta(conversationId: string, text: string) {
      if (!text) return;
      drafts.set(conversationId, (drafts.get(conversationId) ?? "") + text);
      emit(conversationId, { type: "delta", text });
    },
    end(conversationId: string) {
      drafts.delete(conversationId);
      emit(conversationId, { type: "end" });
    },
  };
}

let hub: ReturnType<typeof createModelTextHub> | undefined;
export const getModelTextHub = () => (hub ??= createModelTextHub());
