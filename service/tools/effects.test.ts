import { loadContextRecord } from "../runtime/records.ts";
import { loadMemory } from "../memory/store.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolArguments, Turn } from "../types.ts";
import { errorMessage } from "../../shared/errors.ts";
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
    stopReason: null, assembled: {
      baseToolsIds: ["finishTurn"], toolIds: ["page.click"],
      conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], currentPage: null, currentTabs: { ok: true, windows: [] },
      observations: [],
    },
  };
  const execute = (name: string, args: ToolArguments, options: Partial<ExecuteInput> = {}) => executeTool({
    name, arguments: args, dataDir, browserNames: [], conversationId: ledger.conversationId,
    lookup: {
      unusedTools: ["capture_page"],
      knownTools: ["finishTurn", "page.click", "capture_page", "actions.write"],
      enabledTools: [...turn.assembled.baseToolsIds, ...turn.assembled.toolIds, "actions.write"],
      protectedTools: [...turn.assembled.baseToolsIds],
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
  expect(JSON.parse(execution.text)).toEqual({ ok: false, faultCode: "unknown_tool", message: errorMessage("unknown_tool", "model"), recovery: "correct_arguments", details: {}, toolName: "catalog.add", added: ["capture_page"], alreadyEnabled: ["page.click", "finishTurn"], unknown: ["missing"] });
  expect(fixture.turn.assembled.toolIds).toEqual(["page.click"]);
  fixture.apply(execution);
  expect(loadTurn(fixture.dataDir, fixture.ledger.conversationId, fixture.turn.turnId).assembled.toolIds).toEqual(["page.click", "capture_page"]);
  const repeated = await fixture.execute("catalog.add", { names: ["capture_page"] });
  expect(JSON.parse(repeated.text)).toEqual({ ok: true, added: [], alreadyEnabled: ["capture_page"], unknown: [] });
  expect(repeated.effects).toEqual([]);
});

test("catalog.add mode=remove unloads loaded tools and keeps core tools enabled", async () => {
  const fixture = setup();
  const added = await fixture.execute("catalog.add", { names: ["capture_page"] });
  fixture.apply(added);
  expect(fixture.turn.assembled.toolIds).toEqual(["page.click", "capture_page"]);

  const removed = await fixture.execute("catalog.add", { names: ["capture_page", "finishTurn", "not_loaded"], mode: "remove" });
  expect(JSON.parse(removed.text)).toEqual({
    ok: true, mode: "remove", removed: ["capture_page"], notLoaded: ["not_loaded"], protectedKept: ["finishTurn"],
  });
  expect(removed.effects).toEqual([{ type: "tools.disable", names: ["capture_page"] }]);
  fixture.apply(removed);
  expect(fixture.turn.assembled.toolIds).toEqual(["page.click"]);
  expect(loadLedger(fixture.dataDir, fixture.ledger.conversationId).loadedToolIds).toEqual([]);

  const again = await fixture.execute("catalog.add", { names: ["capture_page"], mode: "remove" });
  expect(JSON.parse(again.text)).toEqual({ ok: true, mode: "remove", removed: [], notLoaded: ["capture_page"], protectedKept: [] });
  expect(again.effects).toEqual([]);
});

test("runtime persists notes through effects", async () => {
  const fixture = setup();
  fixture.apply(await fixture.execute("notes.write", { key: " candidate ", value: "页面 A" }));
  let saved = loadLedger(fixture.dataDir, fixture.ledger.conversationId);
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
    text: "找到按钮", turnId: fixture.turn.turnId, sourceCallId: "call_memory", layer: "conversation",
  });
});

test("closing effects persist lifecycle changes; empty replies request another inference", async () => {
  const fixture = setup();
  fixture.ledger.toolQueue = [{ callId: "later", name: "unused", arguments: {} }];
  expect(fixture.apply(await fixture.execute("askUser", { question: "继续吗？", choice: ["是", "否"] })))
    .toEqual({ kind: "ask", question: "继续吗？\n选项：是 / 否" });
  expect(loadLedger(fixture.dataDir, fixture.ledger.conversationId).status).toBe("waiting_human");
  expect(fixture.apply(await fixture.execute("finishTurn", { text: "已完成"}))).toEqual({ kind: "reply", text: "已完成" });
  const saved = loadLedger(fixture.dataDir, fixture.ledger.conversationId);
  expect(saved.status).toBe("idle");
  expect(saved.active).toBeNull();
  expect(saved.pendingAsk).toBeNull();
  expect(saved.toolQueue).toEqual([]);
  expect(loadTurn(fixture.dataDir, saved.conversationId, fixture.turn.turnId).stopReason).toEqual({ kind: "reply", text: "已完成" });
  const empty = await fixture.execute("finishTurn", {});
  expect(empty.effects).toEqual([{ type: "queue.clear" }]);
  expect(empty.text).toContain("finishTurn 的回复为空");
});

test("turn close archives non-empty reflect into reflectHistory once per turn", async () => {
  const fixture = setup();
  expect(fixture.ledger.reflectHistory).toEqual([]);
  fixture.apply(await fixture.execute("reflect.write", { reason: "记依据", text: "下一步绕过滑块", focus: "意图" }));
  expect(fixture.turn.reflect).toEqual([{ id: "rf_01", text: "下一步绕过滑块", focus: "意图" }]);
  expect(fixture.ledger.reflectHistory).toEqual([]);
  fixture.apply(await fixture.execute("finishTurn", { text: "收口" }));
  expect(loadLedger(fixture.dataDir, fixture.ledger.conversationId).reflectHistory).toEqual([
    { turnId: fixture.turn.turnId, items: [{ id: "rf_01", text: "下一步绕过滑块", focus: "意图" }], at: expect.any(String) },
  ]);
  // second close of same turn overwrites, does not duplicate
  fixture.turn.reflect = [{ id: "rf_02", text: "更新后的承接" }];
  fixture.apply(await fixture.execute("finishTurn", { text: "再收口" }), "call_close2");
  const history = loadLedger(fixture.dataDir, fixture.ledger.conversationId).reflectHistory;
  expect(history).toHaveLength(1);
  expect(history[0]!.items).toEqual([{ id: "rf_02", text: "更新后的承接" }]);
});

test("page.set only tracks current page; observations require observation.write", async () => {
  const fixture = setup();
  const execution = await fixture.execute("page.click", { reason: "查看详情", tabId: 7 }, {
    browserNames: ["page.click"], host: { execute: async (_name, args) => {
      expect(args).toEqual({ tabId: 7 });
      return { ok: true, tabId: 7, url: "https://example.test", title: "详情" };
    } },
  });
  fixture.apply(execution);
  expect(loadTurn(fixture.dataDir, fixture.ledger.conversationId, fixture.turn.turnId).assembled.currentPage?.title).toBe("详情");
  const failed = await fixture.execute("page.click", { reason: "再点", tabId: 7 }, {
    browserNames: ["page.click"], host: { execute: async () => ({ ok: false, tabId: 7, error: "closed" }) },
  });
  applyToolEffects({
    dataDir: fixture.dataDir, ledger: fixture.ledger, turn: fixture.turn,
    call: { callId: "call_fail", name: "page.click", arguments: {} },
    effects: failed.effects,
  });
  const after = loadTurn(fixture.dataDir, fixture.ledger.conversationId, fixture.turn.turnId);
  expect(after.assembled.observations).toHaveLength(0);
  expect(after.assembled.currentPage?.title).toBe("详情");
  const recorded = await fixture.execute("observation.write", { reason: "记下失败", type: "page.click", result: { ok: false, tabId: 7, error: "closed" }, tabId: 7 });
  applyToolEffects({
    dataDir: fixture.dataDir, ledger: fixture.ledger, turn: fixture.turn,
    call: { callId: "call_obs", name: "observation.write", arguments: {} },
    effects: recorded.effects,
  });
  const logged = loadTurn(fixture.dataDir, fixture.ledger.conversationId, fixture.turn.turnId);
  expect(logged.assembled.observations).toHaveLength(1);
  expect(logged.assembled.observations[0]).toMatchObject({
    callId: "call_obs", type: "page.click",
    result: { ok: false, tabId: 7, error: "closed" },
  });
});

test("observation.write records screenshot without leaking pixels and keeps prior page identity", async () => {
  const fixture = setup();
  fixture.turn.assembled.currentPage = {
    tabId: 1, url: "https://example.test/input", title: "发话页面", description: "发送消息时的标签快照",
  };
  const execution = await fixture.execute("observation.write", {
    reason: "截图结论", type: "capture_page", tabId: 1,
    result: { ok: true, tabId: 1, image: { imageId: "img_shot", path: "/tmp/shot.jpg", width: 10, height: 10 }, mime: "image/jpeg", image_size: [10, 10] },
  });
  applyToolEffects({
    dataDir: fixture.dataDir, ledger: fixture.ledger, turn: fixture.turn,
    call: { callId: "call_shot", name: "observation.write", arguments: {} },
    effects: execution.effects,
  });
  const turn = loadTurn(fixture.dataDir, fixture.ledger.conversationId, fixture.turn.turnId);
  expect(turn.assembled.observations).toHaveLength(1);
  expect(turn.assembled.observations[0]).toMatchObject({
    tabId: 1, type: "capture_page", callId: "call_shot",
  });
  expect(JSON.stringify(turn.assembled.observations[0])).not.toContain("data:image");
  expect(turn.assembled.currentPage).toMatchObject({
    tabId: 1, url: "https://example.test/input", title: "发话页面",
  });
});

test("observation.write persists observations in chronological order", () => {
  const fixture = setup();
  fixture.turn.assembled.currentPage = {
    tabId: 1, url: "https://example.test/input", title: "发话页面", description: "发送消息时的标签快照",
  };
  expect(fixture.turn.assembled.observations).toEqual([]);

  const pages = [
    { tabId: 2, url: "https://example.test/results", title: "搜索结果", description: "找到两个结果" },
    { tabId: 3, url: "https://example.test/detail", title: "详情", description: "已打开结果详情" },
  ];
  const results = [
    { ok: true, tabId: 2, url: "https://example.test/results", title: "搜索结果", description: "找到两个结果", headings: ["结果"] },
    { ok: true, tabId: 3, url: "https://example.test/detail", title: "详情", description: "已打开结果详情", clicked: "打开" },
  ];
  const calls = [
    { callId: "call_results", name: "observation.write", arguments: {} },
    { callId: "call_detail", name: "observation.write", arguments: {} },
  ];
  const startedAt = Date.now();
  for (let index = 0; index < pages.length; index++) {
    applyToolEffects({
      dataDir: fixture.dataDir, ledger: fixture.ledger, turn: fixture.turn,
      call: calls[index]!,
      effects: [{ type: "observation.write", observationType: index === 0 ? "page.get_summary" : "page.click", result: results[index]!, tabId: pages[index]!.tabId }],
    });
    applyToolEffects({
      dataDir: fixture.dataDir, ledger: fixture.ledger, turn: fixture.turn,
      call: calls[index]!, effects: [{ type: "page.set", page: pages[index]!, result: results[index]! }],
    });
  }

  expect(fixture.turn.assembled.currentPage).toMatchObject(pages[1]!);
  const history = fixture.turn.assembled.observations;
  expect(history).toHaveLength(2);
  expect(history[0]!.id).not.toBe(history[1]!.id);
  for (const record of history) {
    expect(JSON.parse(loadContextRecord(fixture.dataDir, fixture.ledger.conversationId, "observation", record.id)!)).toEqual(record);
  }
  expect(history).toEqual(results.map((result, index) => ({
    id: expect.any(String),
    turnId: fixture.turn.turnId,
    observedAt: expect.any(String),
    callId: calls[index]!.callId,
    tabId: pages[index]!.tabId,
    type: index === 0 ? "page.get_summary" : "page.click",
    result,
    writtenTurn: fixture.ledger.userInputHistory.length + 1,
  })));
  const observedTimes = history.map((page) => Date.parse(page.observedAt));
  expect(observedTimes[0]!).toBeGreaterThanOrEqual(startedAt);
  expect(observedTimes[1]!).toBeGreaterThanOrEqual(observedTimes[0]!);
  expect(observedTimes[1]!).toBeLessThanOrEqual(Date.now());
  expect(loadTurn(fixture.dataDir, fixture.ledger.conversationId, fixture.turn.turnId).assembled)
    .toEqual(fixture.turn.assembled);
});

test("actions.write appends turn actions with stable act_ ids", async () => {
  const fixture = setup();
  const first = await fixture.execute("actions.write", { reason: "记一笔", text: "调用 list_tabs，拿到 3 个标签" });
  expect(JSON.parse(first.text)).toMatchObject({ ok: true });
  fixture.apply(first);
  const second = await fixture.execute("actions.write", { reason: "再记", text: "调用 page.click，页面已跳转" });
  fixture.apply(second, "call_actions_2");
  expect(fixture.turn.actions).toHaveLength(2);
  expect(fixture.turn.actions![0]).toMatchObject({ text: "调用 list_tabs，拿到 3 个标签" });
  expect(fixture.turn.actions![1]!.id).toMatch(/^act_/);
  expect(loadTurn(fixture.dataDir, fixture.ledger.conversationId, fixture.turn.turnId).actions).toHaveLength(2);
  const missing = await fixture.execute("actions.write", { reason: "空", text: "  " });
  expect(JSON.parse(missing.text)).toMatchObject({ ok: false, faultCode: "invalid_arguments" });
});
