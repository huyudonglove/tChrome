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
    output: null, goalChanges: [], assembled: {
      baseToolsIds: ["finishTurn"], toolIds: ["page.click"],
      conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], currentPage: null, openTabs: { ok: true, windows: [] },
      pageObservedHistory: [],
    },
  };
  const execute = (name: string, args: ToolArguments, options: Partial<ExecuteInput> = {}) => executeTool({
    name, arguments: args, dataDir, browserNames: [], conversationId: ledger.conversationId,
    goalContext: { goals: ledger.goals, currentGoalId: ledger.currentGoalId, turnId: turn.turnId, sourceCallId: "call_effects" },
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
  expect(JSON.parse(execution.text)).toEqual({ ok: false, faultCode: "unknown_tool", message: errorMessage("unknown_tool", "model"), recovery: "correct_arguments", details: {}, toolName: "catalog.add", added: ["capture_page"], alreadyEnabled: ["page.click", "finishTurn"], unknown: ["missing"] });
  expect(fixture.turn.assembled.toolIds).toEqual(["page.click"]);
  fixture.apply(execution);
  expect(loadTurn(fixture.dataDir, fixture.ledger.conversationId, fixture.turn.turnId).assembled.toolIds).toEqual(["page.click", "capture_page"]);
  const repeated = await fixture.execute("catalog.add", { names: ["capture_page"] });
  expect(JSON.parse(repeated.text)).toEqual({ ok: true, added: [], alreadyEnabled: ["capture_page"], unknown: [] });
  expect(repeated.effects).toEqual([]);
});

test("runtime persists stable hierarchical goals, explicit lifecycle and notes through effects", async () => {
  const fixture = setup();
  const submit = async (args: ToolArguments) => {
    const execution = await fixture.execute("submitGoal", args);
    const returned = JSON.parse(execution.text);
    expect(returned.ok).toBe(true);
    fixture.apply(execution);
    return { ...returned.record, currentGoalId: returned.currentGoalId };
  };
  const root = await submit({ goal: "测试站点" });
  const child = await submit({ parentId: root.id, goal: "测试登录" });
  const sibling = await submit({ parentId: root.id, goal: "测试设置" });
  const otherRoot = await submit({ goal: "整理报告" });
  expect([root.id, child.id, sibling.id, otherRoot.id]).toEqual(["goal_01", "subgoal_01", "subgoal_02", "goal_02"]);
  const updated = await submit({ id: child.id, goal: "验证登录结果" });
  expect(updated).toMatchObject({ id: child.id, parentId: root.id, createdAt: child.createdAt, currentGoalId: child.id });
  const complete = await submit({ id: child.id, status: "completed" });
  expect(complete).toMatchObject({ id: child.id, goal: "验证登录结果", status: "completed", currentGoalId: root.id });
  await submit({ id: sibling.id });
  expect((await submit({ id: sibling.id, status: "cancelled" })).currentGoalId).toBe(root.id);
  expect((await submit({ id: root.id, status: "completed" })).currentGoalId).toBeNull();
  await submit({ id: sibling.id, status: "active" });
  await submit({ id: root.id, status: "cancelled" });
  expect(fixture.ledger.currentGoalId).toBe(sibling.id);
  for (const args of [{ goal: "missing parent", parentId: "goal_99" }, { goal: "nested", parentId: sibling.id }, { id: "subgoal_99", status: "completed" }, { id: child.id, parentId: otherRoot.id }]) {
    const execution = await fixture.execute("submitGoal", args);
    expect(JSON.parse(execution.text)).toMatchObject({ ok: false, faultCode: "invalid_arguments" });
    expect(execution.effects).toEqual([]);
  }
  fixture.apply(await fixture.execute("notes.write", { key: " candidate ", value: "页面 A" }));
  let saved = loadLedger(fixture.dataDir, fixture.ledger.conversationId);
  expect(saved.goals).toHaveLength(4);
  expect(saved.goals.find(record => record.id === otherRoot.id)?.status).toBe("active");
  expect(saved.goals.find(record => record.id === sibling.id)?.status).toBe("active");
  expect(saved.currentGoalId).toBe(sibling.id);
  for (const record of saved.goals) {
    expect(JSON.parse(loadContextRecord(fixture.dataDir, saved.conversationId, "goal", record.id)!)).toEqual(record);
  }
  const changes = loadTurn(fixture.dataDir, saved.conversationId, fixture.turn.turnId).goalChanges;
  expect(changes.find(record => record.id === child.id)).toMatchObject({ goal: "测试登录", status: "active" });
  expect(changes.filter(record => record.id === child.id).at(-1)).toMatchObject({ goal: "验证登录结果", status: "completed" });
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
  expect(fixture.apply(await fixture.execute("finishTurn", { text: "已完成", summary: "已完成"}))).toEqual({ kind: "reply", text: "已完成", summary: "已完成" });
  const saved = loadLedger(fixture.dataDir, fixture.ledger.conversationId);
  expect(saved.status).toBe("idle");
  expect(saved.active).toBeNull();
  expect(saved.pendingAsk).toBeNull();
  expect(saved.toolQueue).toEqual([]);
  expect(loadTurn(fixture.dataDir, saved.conversationId, fixture.turn.turnId).output).toEqual({ kind: "reply", text: "已完成", summary: "已完成" });
  const empty = await fixture.execute("finishTurn", {});
  expect(empty.effects).toEqual([{ type: "queue.clear" }]);
  expect(empty.text).toContain("finishTurn 的回复为空");
});

test("browser page metadata becomes a typed effect; failed tab calls log observations without replacing the current page", async () => {
  const fixture = setup();
  const execution = await fixture.execute("page.click", { reason: "查看详情", affectsPage: true, tabId: 7 }, {
    browserNames: ["page.click"], host: { execute: async (_name, args) => {
      expect(args).toEqual({ tabId: 7 });
      return { ok: true, tabId: 7, url: "https://example.test", title: "详情" };
    } },
  });
  fixture.apply(execution);
  expect(loadTurn(fixture.dataDir, fixture.ledger.conversationId, fixture.turn.turnId).assembled.currentPage?.title).toBe("详情");
  const failed = await fixture.execute("page.click", { reason: "再点", affectsPage: true, tabId: 7 }, {
    browserNames: ["page.click"], host: { execute: async () => ({ ok: false, tabId: 7, error: "closed" }) },
  });
  applyToolEffects({
    dataDir: fixture.dataDir, ledger: fixture.ledger, turn: fixture.turn,
    call: { callId: "call_fail", name: "page.click", arguments: {} },
    effects: failed.effects,
  });
  const after = loadTurn(fixture.dataDir, fixture.ledger.conversationId, fixture.turn.turnId);
  expect(after.assembled.pageObservedHistory).toHaveLength(2);
  expect(after.assembled.pageObservedHistory[1]).toMatchObject({
    callId: "call_fail", type: "page.click",
    result: { ok: false, tabId: 7, error: "closed" },
  });
  expect(after.assembled.currentPage?.title).toBe("详情");
});

test("successful tab-targeted calls without url still enter page observations", async () => {
  const fixture = setup();
  fixture.turn.assembled.currentPage = {
    tabId: 1, url: "https://example.test/input", title: "发话页面", description: "发送消息时的标签快照",
  };
  const execution = await fixture.execute("capture_page", { reason: "截图", affectsPage: false, mode: "viewport", tabId: 1 }, {
    browserNames: ["capture_page"], host: { execute: async () => ({
      ok: true, tabId: 1, image: "data:image/jpeg;base64,xx", mime: "image/jpeg", image_size: [10, 10],
    }) },
  });
  applyToolEffects({
    dataDir: fixture.dataDir, ledger: fixture.ledger, turn: fixture.turn,
    call: { callId: "call_shot", name: "capture_page", arguments: {} },
    effects: execution.effects,
  });
  const turn = loadTurn(fixture.dataDir, fixture.ledger.conversationId, fixture.turn.turnId);
  expect(turn.assembled.pageObservedHistory).toHaveLength(1);
  expect(turn.assembled.pageObservedHistory[0]).toMatchObject({
    tabId: 1, type: "capture_page", callId: "call_shot",
    result: { ok: true, tabId: 1, image: "data:image/jpeg;base64,xx" },
  });
  // Previous page identity is kept when the call did not return url/title.
  expect(turn.assembled.currentPage).toMatchObject({
    tabId: 1, url: "https://example.test/input", title: "发话页面",
  });
});

test("page effects update the current page and persist observations in chronological order", () => {
  const fixture = setup();
  fixture.turn.assembled.currentPage = {
    tabId: 1, url: "https://example.test/input", title: "发话页面", description: "发送消息时的标签快照",
  };
  expect(fixture.turn.assembled.pageObservedHistory).toEqual([]);

  const pages = [
    { tabId: 2, url: "https://example.test/results", title: "搜索结果", description: "找到两个结果" },
    { tabId: 3, url: "https://example.test/detail", title: "详情", description: "已打开结果详情" },
  ];
  const results = [
    { ok: true, tabId: 2, url: "https://example.test/results", title: "搜索结果", description: "找到两个结果", headings: ["结果"] },
    { ok: true, tabId: 3, url: "https://example.test/detail", title: "详情", description: "已打开结果详情", clicked: "打开" },
  ];
  const calls = [
    { callId: "call_results", name: "page.get_summary", arguments: {} },
    { callId: "call_detail", name: "page.click", arguments: {} },
  ];
  const startedAt = Date.now();
  for (let index = 0; index < pages.length; index++) {
    applyToolEffects({
      dataDir: fixture.dataDir, ledger: fixture.ledger, turn: fixture.turn,
      call: calls[index]!, effects: [{ type: "page.set", page: pages[index]!, result: results[index]! }],
    });
  }

  expect(fixture.turn.assembled.currentPage).toMatchObject(pages[1]!);
  const history = fixture.turn.assembled.pageObservedHistory;
  expect(history).toHaveLength(2);
  expect(history[0]!.id).not.toBe(history[1]!.id);
  for (const record of history) {
    expect(JSON.parse(loadContextRecord(fixture.dataDir, fixture.ledger.conversationId, "pageObservation", record.id)!)).toEqual(record);
  }
  expect(history).toEqual(results.map((result, index) => ({
    id: expect.any(String),
    turnId: fixture.turn.turnId,
    observedAt: expect.any(String),
    callId: calls[index]!.callId,
    tabId: pages[index]!.tabId,
    type: calls[index]!.name,
    result,
  })));
  const observedTimes = history.map((page) => Date.parse(page.observedAt));
  expect(observedTimes[0]!).toBeGreaterThanOrEqual(startedAt);
  expect(observedTimes[1]!).toBeGreaterThanOrEqual(observedTimes[0]!);
  expect(observedTimes[1]!).toBeLessThanOrEqual(Date.now());
  expect(loadTurn(fixture.dataDir, fixture.ledger.conversationId, fixture.turn.turnId).assembled)
    .toEqual(fixture.turn.assembled);
});
