import { loadContextRecord } from "../runtime/records.ts";
import { loadMemory } from "../memory/store.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolArguments, Turn } from "../types.ts";
import { executeTool, type ExecuteInput } from "./execute.ts";
import { applyToolEffects } from "../runtime/effects.ts";
import { emptyLedger, loadLedger, loadTurn } from "../runtime/store.ts";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-effects-"));
  directories.push(dataDir);
  const ledger = emptyLedger("cv_effects");
  ledger.status = "running";
  ledger.active = { turnId: "tn_effects" };
  const turn: Turn = {
    turnId: "tn_effects", conversationId: ledger.conversationId, status: "inferring",
    createdAt: new Date().toISOString(), completedAt: null, input: { id: "input_fixture", text: "检查", submittedAt: "now" },
    output: null, assembled: {
      baseToolsIds: ["finishTurn"], toolIds: ["page.click"],
      conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], currentPage: null, currentTab: null,
      pageObservedHistory: [],
    },
  };
  const execute = (name: string, args: ToolArguments, options: Partial<ExecuteInput> = {}) => executeTool({
    name, arguments: args, content: "", dataDir, browserNames: [],
    lookup: {
      unusedTools: ["capture_page"],
      knownTools: ["finishTurn", "page.click", "capture_page"],
      enabledTools: [...turn.assembled.baseToolsIds, ...turn.assembled.toolIds],
    },
    ...options,
  });
  const apply = (execution: Awaited<ReturnType<typeof executeTool>>, callId = "call_effects") =>
    applyToolEffects({ dataDir, ledger, turn, call: { callId, name: "opaque-runtime-call", arguments: {} }, effects: execution.effects });
  return { dataDir, ledger, turn, execute, apply };
}

test("catalog.add reports only enabled names and distinguishes duplicates and unknown tools", async () => {
  const fixture = setup();
  const execution = await fixture.execute("catalog.add", { names: ["capture_page", "capture_page", "page.click", "finishTurn", "missing"] });
  expect(JSON.parse(execution.text)).toEqual({ ok: false, added: ["capture_page"], alreadyEnabled: ["page.click", "finishTurn"], unknown: ["missing"] });
  expect(fixture.turn.assembled.toolIds).toEqual(["page.click"]);
  fixture.apply(execution);
  expect(loadTurn(fixture.dataDir, fixture.ledger.conversationId, fixture.turn.turnId).assembled.toolIds).toEqual(["page.click", "capture_page"]);
  const repeated = await fixture.execute("catalog.add", { names: ["capture_page"] });
  expect(JSON.parse(repeated.text)).toEqual({ ok: true, added: [], alreadyEnabled: ["capture_page"], unknown: [] });
  expect(repeated.effects).toEqual([]);
});

test("runtime persists goals and notes from effects without interpreting the original tool name or arguments", async () => {
  const fixture = setup();
  fixture.apply(await fixture.execute("submitGoal", { goal: "第一目标" }));
  fixture.apply(await fixture.execute("submitGoal", { goal: "第二目标" }));
  fixture.apply(await fixture.execute("submitGoal", { goal: "第二目标" }));
  fixture.apply(await fixture.execute("notes.write", { key: " candidate ", value: "页面 A" }));
  let saved = loadLedger(fixture.dataDir, fixture.ledger.conversationId);
  expect(saved.goal?.goal).toBe("第二目标");
  expect(saved.goalHistory.map(item => item.goal)).toEqual(["第一目标"]);
  for (const record of [...saved.goalHistory, saved.goal!]) {
    expect(JSON.parse(loadContextRecord(fixture.dataDir, saved.conversationId, "goal", record.id)!)).toEqual(record);
  }
  expect(saved.goal!.id).not.toBe(saved.goalHistory[0]!.id);
  expect(saved.notes).toEqual({ candidate: "页面 A" });
  fixture.apply(await fixture.execute("notes.delete", { key: "candidate" }));
  saved = loadLedger(fixture.dataDir, fixture.ledger.conversationId);
  expect(saved.notes).toEqual({});
});

test("memory effects contain normalized entries and runtime persists their source and summary", async () => {
  const fixture = setup();
  const execution = await fixture.execute("memory.write", {
    conversationMemory: ["找到按钮", "", null, "用户目标"], projectMemory: [],
  });
  expect(execution.text).toBe("落下 conversation=2 project=0");
  expect(fixture.ledger.memoryIds.conversation).toEqual([]);
  fixture.apply(execution, "call_memory");
  const saved = loadLedger(fixture.dataDir, fixture.ledger.conversationId);
  expect(saved.memoryIds.conversation).toHaveLength(2);
  expect(loadMemory(fixture.dataDir, saved.conversationId, saved.memoryIds.conversation[0]!)).toMatchObject({
    text: "找到按钮", sourceCallId: "call_memory", layer: "conversation",
  });
});

test("closing effects persist lifecycle changes; empty replies request another inference", async () => {
  const fixture = setup();
  fixture.ledger.toolQueue = [{ callId: "later", name: "unused", arguments: {} }];
  expect(fixture.apply(await fixture.execute("askUser", { question: "继续吗？", choice: ["是", "否"] })))
    .toEqual({ kind: "ask", question: "继续吗？\n选项：是 / 否" });
  expect(loadLedger(fixture.dataDir, fixture.ledger.conversationId).status).toBe("waiting_human");
  expect(fixture.apply(await fixture.execute("finishTurn", { text: "已完成" }))).toEqual({ kind: "reply", text: "已完成" });
  const saved = loadLedger(fixture.dataDir, fixture.ledger.conversationId);
  expect(saved.status).toBe("idle");
  expect(saved.active).toBeNull();
  expect(saved.pendingAsk).toBeNull();
  expect(saved.toolQueue).toEqual([]);
  expect(loadTurn(fixture.dataDir, saved.conversationId, fixture.turn.turnId).output).toEqual({ kind: "reply", text: "已完成" });
  const empty = await fixture.execute("finishTurn", {});
  expect(empty.effects).toEqual([{ type: "queue.clear" }]);
  expect(empty.text).toContain("finishTurn 的回复为空");
});

test("browser page metadata becomes a typed effect; failed results cannot replace the current page", async () => {
  const fixture = setup();
  const execution = await fixture.execute("page.click", { reason: "查看详情", affectsPage: true, tab: 7 }, {
    browserNames: ["page.click"], host: { execute: async (_name, args) => {
      expect(args).toEqual({ tab: 7 });
      return { ok: true, tab: 7, url: "https://example.test", title: "详情" };
    } },
  });
  fixture.apply(execution);
  expect(loadTurn(fixture.dataDir, fixture.ledger.conversationId, fixture.turn.turnId).assembled.currentPage?.title).toBe("详情");
  const failed = await fixture.execute("page.click", {}, {
    browserNames: ["page.click"], host: { execute: async () => ({ ok: false, tab: 8, error: "closed" }) },
  });
  expect(failed.effects).toEqual([]);
});

test("page effects update the current page and persist observations in chronological order", () => {
  const fixture = setup();
  fixture.turn.assembled.currentPage = {
    tab: 1, url: "https://example.test/input", title: "发话页面", description: "发送消息时的标签快照",
  };
  expect(fixture.turn.assembled.pageObservedHistory).toEqual([]);

  const pages = [
    { tab: 2, url: "https://example.test/results", title: "搜索结果", description: "找到两个结果" },
    { tab: 3, url: "https://example.test/detail", title: "详情", description: "已打开结果详情" },
  ];
  const calls = [
    { callId: "call_results", name: "page.get_summary", arguments: {} },
    { callId: "call_detail", name: "page.click", arguments: {} },
  ];
  const startedAt = Date.now();
  for (let index = 0; index < pages.length; index++) {
    applyToolEffects({
      dataDir: fixture.dataDir, ledger: fixture.ledger, turn: fixture.turn,
      call: calls[index]!, effects: [{ type: "page.set", page: pages[index]! }],
    });
  }

  expect(fixture.turn.assembled.currentPage).toMatchObject(pages[1]!);
  const history = fixture.turn.assembled.pageObservedHistory;
  expect(history).toHaveLength(2);
  expect(fixture.turn.assembled.currentPage).toEqual(history[1]!);
  expect(history[0]!.id).not.toBe(history[1]!.id);
  for (const record of history) {
    expect(JSON.parse(loadContextRecord(fixture.dataDir, fixture.ledger.conversationId, "pageObservation", record.id)!)).toEqual(record);
  }
  expect(history).toEqual(pages.map((page, index) => ({
    ...page, id: expect.any(String), turnId: fixture.turn.turnId, observedAt: expect.any(String), callId: calls[index]!.callId, toolName: calls[index]!.name,
  })));
  const observedTimes = history.map((page) => Date.parse(page.observedAt));
  expect(observedTimes[0]!).toBeGreaterThanOrEqual(startedAt);
  expect(observedTimes[1]!).toBeGreaterThanOrEqual(observedTimes[0]!);
  expect(observedTimes[1]!).toBeLessThanOrEqual(Date.now());
  expect(loadTurn(fixture.dataDir, fixture.ledger.conversationId, fixture.turn.turnId).assembled)
    .toEqual(fixture.turn.assembled);
});
