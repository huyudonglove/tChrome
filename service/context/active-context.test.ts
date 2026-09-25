import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadContextModules, registryModules, loadModuleRegistry } from "./modules.ts";
import { userText } from "./window.ts";
import { projectActiveContext } from "./projections/active-context.ts";
import { emptyLedger } from "../runtime/store.ts";
import type { Turn } from "../types.ts";

const root = join(import.meta.dir, "../..");

const fixture = () => {
  const ledger = emptyLedger("cv_ac");
  ledger.currentGoalId = "goal_01";
  ledger.goals = [{
    id: "goal_01", parentId: null, goal: "注册账号", status: "active",
    turnId: "tn_02", sourceCallId: "call_01",
    createdAt: "2026-09-25", updatedAt: "2026-09-25",
    taskId: "task_01", activeTaskItemId: "item_02",
  }];
  ledger.tasks = [{
    id: "task_01", goalId: "goal_01", title: "注册", status: "active",
    createdAt: "2026-09-25", updatedAt: "2026-09-25",
    items: [
      { id: "item_01", index: 0, text: "打开注册页", status: "done", createdAt: "2026-09-25" },
      { id: "item_02", index: 1, text: "填写邮箱", status: "doing", createdAt: "2026-09-25" },
      { id: "item_03", index: 2, text: "提交表单", status: "todo", createdAt: "2026-09-25" },
    ],
  }];
  ledger.activeTaskId = "task_01";
  ledger.activeTaskItemId = "item_02";
  ledger.notes = {
    temp_email: "a@b.com",
    blob: JSON.stringify({ account_id: "acc_9", password: "pw" }),
    log: "line1\nline2\nline3",
  };
  ledger.toolIO = [
    { callId: "call_01", batchId: "batch_01", turnId: "tn_02", name: "open_tab", arguments: { reason: "打开", tabId: 11, windowId: 1 }, return: { stage: "complete", totalChars: 2, text: "{}" } },
    { callId: "call_02", batchId: "batch_01", turnId: "tn_02", name: "page.get_summary", arguments: { reason: "看页", tabId: 11 }, return: { stage: "complete", totalChars: 2, text: "{}" } },
    { callId: "call_03", batchId: "batch_02", turnId: "tn_02", name: "page.type", arguments: { reason: "输入", tabId: 11 }, return: { stage: "complete", totalChars: 2, text: "{}" } },
  ];
  const turn: Turn = {
    goalChanges: [], turnId: "tn_02", conversationId: "cv_ac", status: "inferring",
    createdAt: "2026-09-25", completedAt: null,
    input: { id: "input_02", text: "注册账号", submittedAt: "2026-09-25" },
    output: null,
    assembled: {
      baseToolsIds: [], toolIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [],
      currentPage: null,
      openTabs: {
        ok: true,
        windows: [{
          windowId: 1, focused: true,
          tabs: [
            { tabId: 9, url: "https://other.example", title: "Other", active: false },
            { tabId: 11, url: "https://devinno.digital3dcloud.com/signup", title: "Create Account", active: true },
          ],
        }],
      },
      pageObservedHistory: [],
    },
  };
  return { ledger, turn };
};

test("projectActiveContext binds doing item, primary tab, entities and handover fallback", () => {
  const { ledger, turn } = fixture();
  const view = projectActiveContext({ ledger, turn });
  expect(view.goalId).toBe("goal_01");
  expect(view.activeTaskItem).toMatchObject({ id: "item_02", text: "填写邮箱" });
  expect(view.focus).toEqual({
    primaryTabId: 11,
    primaryTabTitle: "Create Account",
    urlPrefix: "https://devinno.digital3dcloud.com",
  });
  expect(view.activeEntities).toEqual({
    temp_email: "a@b.com",
    account_id: "acc_9",
    password: "pw",
  });
  expect(view.activeEntities.draft).toBeUndefined();
  expect(view.handoverIntent).toBe("填写邮箱");

  // Non-HTTP protocol urlPrefix fallback
  turn.assembled.openTabs.windows[0]!.tabs[1]!.url = "chrome://extensions/";
  expect(projectActiveContext({ ledger, turn }).focus.urlPrefix).toBe("chrome://extensions");

  ledger.notes.long_draft = "A".repeat(81);
  expect(projectActiveContext({ ledger, turn }).activeEntities.long_draft).toBeUndefined();

  ledger.notes.draft = "N".repeat(210_000);
  expect(projectActiveContext({ ledger, turn }).activeEntities.draft).toBeUndefined();

  ledger.reflectHistory.push({
    turnId: "tn_01",
    items: [{ id: "rf_01", text: "下一步绕过风控滑块" }],
    at: "2026-09-24T12:00:00.000Z",
  });
  expect(projectActiveContext({ ledger, turn }).handoverIntent).toBe("下一步绕过风控滑块");

  ledger.activeTaskItemId = "item_03";
  ledger.tasks[0]!.items[1]!.status = "done";
  ledger.tasks[0]!.items[2]!.status = "todo";
  expect(projectActiveContext({ ledger, turn }).activeTaskItem?.id).toBe("item_03");
});

test("activeContext registers in window, README, overview and schema contract", () => {
  const registry = loadModuleRegistry(root);
  const mainUser = registryModules(registry, { role: "user", consumer: "main" }).map((row) => row.id);
  expect(mainUser.indexOf("activeContext")).toBe(mainUser.indexOf("lastAction") + 1);
  expect(mainUser.indexOf("task")).toBe(mainUser.indexOf("activeContext") + 1);
  expect(mainUser.indexOf("reflectHistory")).toBe(mainUser.indexOf("reflection") + 1);

  const modules = loadContextModules(root);
  expect(modules.userOrder).toContain("#activeContext");
  const { ledger, turn } = fixture();
  const output = userText({
    contextModules: modules, ledger, turn,
    memories: { project: "[]", conversation: "[]" }, skillText: "技能",
  });
  expect(output).toContain("<activeContext>");
  expect(output).toContain('"goalId": "goal_01"');
  expect(output.indexOf("<activeContext>")).toBeLessThan(output.indexOf("<task>"));
  expect(output.indexOf("<lastAction>")).toBeLessThan(output.indexOf("<activeContext>"));
});
