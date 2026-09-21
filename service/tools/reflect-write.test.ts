import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadToolRegistry } from "./registry.ts";
import { executeTool } from "./execute.ts";
import { applyToolEffects } from "../runtime/effects.ts";
import { emptyLedger } from "../runtime/store.ts";
import type { Turn } from "../types.ts";

const repoRoot = join(import.meta.dir, "../..");

const turn = (): Turn => ({
  goalChanges: [],
  turnId: "tn_01",
  conversationId: "cv_01",
  status: "inferring",
  createdAt: "now",
  completedAt: null,
  input: { id: "input_01", text: "任务", submittedAt: "now" },
  assembled: { baseToolsIds: [], toolIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], openTabs: { ok: true, windows: [] }, currentPage: null, pageObservedHistory: [] },
  output: null,
});

test("reflect.write is a resident tool and overwrites the current turn reflection", async () => {
  const registry = loadToolRegistry(repoRoot);
  expect(registry.tools["reflect.write"]).toBeTruthy();
  expect(registry.toolGroups.baseToolsIds).toContain("reflect.write");
  expect(registry.tools["reflect.write"]!.function.parameters).toMatchObject({
    required: expect.arrayContaining(["text"]),
  });

  const first = await executeTool({
    name: "reflect.write",
    arguments: { reason: "收口前反思", affectsPage: false, text: "先记一次", focus: "证据" },
    dataDir: "",
    browserNames: [],
    lookup: { unusedTools: [], knownTools: ["reflect.write"], enabledTools: ["reflect.write"] },
  });
  expect(JSON.parse(first.text)).toMatchObject({ ok: true, text: "先记一次", focus: "证据" });
  expect(first.effects).toEqual([{ type: "reflect.write", text: "先记一次", focus: "证据" }]);

  const ledger = emptyLedger("cv_01");
  const current = turn();
  const dataDir = "";
  const call = { callId: "call_01", turnId: "tn_01", name: "reflect.write", arguments: {}, return: { stage: "complete" as const, totalChars: 1, text: "" } };
  applyToolEffects({
    dataDir,
    ledger,
    turn: current,
    call,
    effects: first.effects,
  });
  expect(current.reflect).toEqual({ text: "先记一次", focus: "证据" });

  const second = await executeTool({
    name: "reflect.write",
    arguments: { reason: "更新反思", affectsPage: false, text: "覆盖后的正文" },
    dataDir: "",
    browserNames: [],
    lookup: { unusedTools: [], knownTools: ["reflect.write"], enabledTools: ["reflect.write"] },
  });
  applyToolEffects({ dataDir, ledger, turn: current, call: { ...call, callId: "call_02" }, effects: second.effects });
  expect(current.reflect).toEqual({ text: "覆盖后的正文" });
});
