import type { Ledger, ObservationItem, ObservationRecord } from "../types.ts";
import { nextId, nowIso } from "./ids.ts";
import { appendEvent, saveObservation } from "./store.ts";

export function maybeCompress(input: {
  dataDir: string;
  ledger: Ledger;
  windowChars: number;
}): void {
  const { dataDir, ledger } = input;
  ledger.windowChars = input.windowChars;
  if (ledger.windowChars < ledger.compressAt) return;
  if (ledger.toolIO.length <= 2) return;
  const keep = ledger.toolIO.slice(-2);
  const folded = ledger.toolIO.slice(0, -2);
  const observationId = nextId("ob_", ledger.observation.map((item) => item.id));
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
  appendEvent(dataDir, ledger.conversationId, {
    kind: "compress",
    data: { observationId, windowChars: ledger.windowChars, sourceCallIds: record.sourceCallIds },
  });
}
