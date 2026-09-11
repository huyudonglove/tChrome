import type { ToolIOItem } from "../../types.ts";

function resultView(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

export function toolHistoryView(records: ToolIOItem[]) {
  return records.map(record => {
    const { affectsPage: _affectsPage, ...args } = record.arguments;
    return {
      callId: record.callId,
      turnId: record.turnId,
      batchId: record.batchId,
      name: record.name,
      arguments: args,
      return: { stage: record.return.stage, result: resultView(record.return.text) },
    };
  });
}
