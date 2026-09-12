import type { CurrentPage, PageObservation, ToolIOItem } from "../../types.ts";

function resultView(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

export function toolHistoryView(records: ToolIOItem[], pages: (CurrentPage & Partial<PageObservation>)[] = []) {
  return records.map(record => {
    let result = resultView(record.return.text);
    if (record.return.stage === "complete" && result && typeof result === "object" && !Array.isArray(result)) {
      const fields = result as Record<string, unknown>;
      const page = pages.find(page => page.id && page.turnId === record.turnId && page.callId === record.callId
        && fields.description === page.description && fields.tab === page.tab
        && fields.url === page.url && fields.title === page.title);
      if (page && !("pageObservationId" in fields)) {
        const { description: _description, ...rest } = fields;
        result = { ...rest, pageObservationId: page.id };
      }
    }
    return {
      callId: record.callId,
      turnId: record.turnId,
      batchId: record.batchId,
      name: record.name,
      arguments: { ...record.arguments },
      return: { stage: record.return.stage, result },
    };
  });
}
