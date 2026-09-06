import { MEMORY_WINDOW } from "../context/window.ts";
import type { Catalog } from "../prompt/catalog.ts";
import type { Ledger, MemoryRecord, ObservationItem, ObservationRecord, Turn } from "../types.ts";
import { nextId, nowIso } from "./ids.ts";
import { appendEvent, loadMemory, saveMemory, saveObservation } from "./store.ts";

const summarize = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 80);

const compressLayer = (input: {
  dataDir: string;
  ledger: Ledger;
  layer: "turn" | "conversation";
}): string[] => {
  const compressed: string[] = [];
  for (const memoryId of input.ledger.memoryIds[input.layer]) {
    const record: MemoryRecord = loadMemory(input.dataDir, input.ledger.conversationId, memoryId);
    if (record.compressed) continue;
    record.summary = record.summary || summarize(record.text);
    record.compressed = true;
    saveMemory(input.dataDir, input.ledger.conversationId, record);
    compressed.push(memoryId);
  }
  return compressed;
};

export function maybeCompress(input: {
  dataDir: string;
  ledger: Ledger;
  turn: Turn;
  catalog: Catalog;
  coreToolIds: string[];
  windowChars: number;
}): void {
  const { dataDir, ledger, turn, catalog, coreToolIds } = input;
  ledger.windowChars = input.windowChars;
  if (ledger.windowChars < ledger.compressAt) return;

  const used = new Set(ledger.toolIO.map((row) => row.name));
  const keptTools = turn.assembled.toolIds.filter((id) => coreToolIds.includes(id) || used.has(id));
  const prunedToolIds = turn.assembled.toolIds.filter((id) => !keptTools.includes(id) && catalog.tools[id]);
  turn.assembled.toolIds = keptTools;
  ledger.memoryIds.turn = ledger.memoryIds.turn.slice(-MEMORY_WINDOW);
  ledger.memoryIds.conversation = ledger.memoryIds.conversation.slice(-MEMORY_WINDOW);

  const compressedMemoryIds = [
    ...compressLayer({ dataDir, ledger, layer: "turn" }),
    ...compressLayer({ dataDir, ledger, layer: "conversation" }),
  ];

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
      prunedToolIds,
    },
  });
}
