import type { Ledger, ObservationItem, ObservationRecord } from "../types.ts";
import { nextId, nowIso } from "./ids.ts";
import { appendEvent, saveObservation } from "./store.ts";

/** Runtime evidence archival; never removes memory indexes or unloads tools. */
export function archiveToolHistory(input: { dataDir: string; ledger: Ledger; windowChars: number }): void {
  const { dataDir, ledger } = input;
  if (input.windowChars < ledger.compressAt || ledger.toolIO.length <= 2) return;
  let observationId: string | null = null;
  if (ledger.toolIO.length > 2) {
    const keep = ledger.toolIO.slice(-2);
    const folded = ledger.toolIO.slice(0, -2);
    observationId = nextId("ob_", ledger.observation.map((item) => item.id));
    const full = folded.map((item) => JSON.stringify(item)).join("\n");
    const text = folded.map((item) => `${item.name}:${item.return.text.slice(0, 80)}`).join("；");
    const record: ObservationRecord = {
      observationId,
      text,
      full,
      sourceCallIds: folded.map((item) => item.callId),
      totalChars: full.length,
      createdAt: nowIso(),
    };
    saveObservation(dataDir, ledger.conversationId, record);
    const item: ObservationItem = {
      id: observationId,
      text,
      sourceCallIds: record.sourceCallIds,
    };
    ledger.observation.push(item);
    ledger.toolIO = keep;
  }
  appendEvent(dataDir, ledger.conversationId, {
    kind: "compress",
    data: {
      observationId,
      windowChars: input.windowChars,
      sourceCallIds: observationId ? ledger.observation.at(-1)?.sourceCallIds ?? [] : [],
      compressedMemoryIds: [],
      prunedToolIds: [],
    },
  });
}
