import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "./execute.ts";
import { applyToolEffects } from "../runtime/effects.ts";
import { emptyLedger, loadTurn } from "../runtime/store.ts";
import type { Turn } from "../types.ts";

const setup = () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-clear-page-"));
  const ledger = emptyLedger("cv_clear");
  ledger.status = "running";
  ledger.active = { turnId: "tn_01" };
  const turn: Turn = {
    turnId: "tn_01", conversationId: ledger.conversationId, status: "inferring",
    createdAt: new Date().toISOString(), completedAt: null,
    input: { id: "input_01", text: "清理旧观察", submittedAt: "now" },
    output: null, goalChanges: [],
    assembled: {
      baseToolsIds: ["page.clear_result"], toolIds: [],
      conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [],
      currentPage: { tabId: 12, url: "https://example.com", title: "示例", description: "d" },
      openTabs: { ok: true, windows: [] },
      pageObservedHistory: [{
        id: "page_01", turnId: "tn_01", callId: "call_01", batchId: "batch_01",
        observedAt: "now", tabId: 12, type: "page.inspect_element",
        result: { ok: true, tabId: 12, element: { id: "e_01", rect: { x: 1, y: 2, w: 3, h: 4 } } },
      }],
    },
  };
  return { dataDir, ledger, turn };
};

test("page.clear_result keeps identity and marks result cleared", async () => {
  const { dataDir, ledger, turn } = setup();
  try {
    const execution = await executeTool({
      name: "page.clear_result",
      arguments: { reason: "元素详情不再需要", affectsPage: false, pageId: "page_01" },
      dataDir,
      pageObservationIds: ["page_01"],
      lookup: { knownTools: ["page.clear_result"], enabledTools: ["page.clear_result"], unusedTools: [] },
    });
    expect(JSON.parse(execution.text)).toEqual({ ok: true, pageId: "page_01", cleared: true });
    applyToolEffects({
      dataDir, ledger, turn,
      call: { callId: "call_clear", name: "page.clear_result", arguments: {} },
      effects: execution.effects,
    });
    const saved = loadTurn(dataDir, ledger.conversationId, turn.turnId);
    expect(saved.assembled.pageObservedHistory[0]).toMatchObject({
      id: "page_01", callId: "call_01", batchId: "batch_01", tabId: 12, type: "page.inspect_element",
      result: { ok: true, cleared: true },
    });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("unknown pageId is rejected before effects", async () => {
  const { dataDir } = setup();
  try {
    const execution = await executeTool({
      name: "page.clear_result",
      arguments: { reason: "清理", affectsPage: false, pageId: "page_99" },
      dataDir,
      pageObservationIds: ["page_01"],
      lookup: { knownTools: ["page.clear_result"], enabledTools: ["page.clear_result"], unusedTools: [] },
    });
    expect(execution.effects).toEqual([]);
    expect(JSON.parse(execution.text)).toMatchObject({ ok: false, faultCode: "invalid_arguments" });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
