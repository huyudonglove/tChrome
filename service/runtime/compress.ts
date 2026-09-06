import type { Ledger, MemoryRecord, ObservationItem, ObservationRecord } from "../types.ts";
import { nextId, nowIso } from "./ids.ts";
import { appendEvent, loadMemory, saveMemory, saveObservation } from "./store.ts";

const summarize = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 80);

const compressLayer = (input: {
  dataDir: string;
  ledger: Ledger;
  layer: "turn" | "conversation";
}): void => {
  const ids = input.ledger.memoryIds[input.layer];
  for (const memoryId of ids) {
    const record: MemoryRecord = loadMemory(input.dataDir, input.ledger.conversationId, memoryId);
    if (record.compressed) continue;
    record.summary = record.summary || summarize(record.text);
    record.compressed = true;
    saveMemory(input.dataDir, input.ledger.conversationId, record);
  }
};

export function maybeCompress(input: {
  dataDir: string;
  ledger: Ledger;
  windowChars: number;
}): void {
  const { dataDir, ledger } = input;
  ledger.windowChars = input.windowChars;
  if (ledger.windowChars < ledger.compressAt) return;
  const compressedMemoryIds: string[] = [];
  for (const layer of ["turn", "conversation"] as const) {
    const before = ledger.memoryIds[layer]
      .map((id) => loadMemory(dataDir, ledger.conversationId, id))
      .filter((record) => !record.compressed)
      .map((record) => record.memoryId);
    compressLayer({ dataDir, ledger, layer });
    compressedMemoryIds.push(...before);
  }
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
      windowChars: ledger.windowChars,
      sourceCallIds: observationId ? ledger.observation.at(-1)?.sourceCallIds ?? [] : [],
      compressedMemoryIds,
    },
  });
}
