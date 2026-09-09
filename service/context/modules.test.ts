import { expect, test } from "bun:test";
import { readFileSync, readdirSync, existsSync, mkdtempSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import runtimeMessages from "../runtime/messages.json";
import { join } from "node:path";
import { loadContextModules, renderSlots, slotNames, toolSchemas, toolUsageFor, type ContextModules } from "./modules.ts";
import { systemText, userText } from "../context/window.ts";
import { emptyLedger } from "../runtime/store.ts";
import type { Turn } from "../types.ts";

const root = join(import.meta.dir, "../..");
const developerCopy = /用途与来源|^用途[：:]|^来源[：:]|应用维护|由本文件维护|无运行时附加数据|ledger\.|Turn\.assembled|baseToolsIds|coreToolIds|windowChars|compressAt|contextModules\/|function\.description|Runtime|装配|维护位置/gm;
const system = slotNames(readFileSync(join(root, "context/system-slots.md"), "utf8"));
const user = slotNames(readFileSync(join(root, "context/user-slots.md"), "utf8"));

for (const [role, names] of [["system", system], ["user", user]] as const) {
  test(`${role} 清单、加载顺序和独立槽目录完全一致`, () => {
    const c = loadContextModules(root);
    const inventoryText = role === "system" ? c.systemInventory : c.userInventory;
    const files = role === "system" ? c.systemSlots : c.userSlots;
    const inventory = readFileSync(join(root, `context/${role}-slots.md`), "utf8");
    const listed = Array.from(inventory.matchAll(/^\| \d+ \|.*?`(#[^`]+)`/gm), m => m[1]);
    expect(listed).toEqual(names);
    expect(slotNames(inventoryText)).toEqual(names);
    expect(readdirSync(join(root, "context", role)).sort()).toEqual(names.map(n => `${n.slice(1)}.md`).sort());
    for (const name of names) {
      expect(files[name]?.startsWith(`${name}\n`)).toBe(true);
      if (role === "user") expect(files[name]).toBe(`${name}\n\n{{data}}`);
      expect(files[name]).not.toMatch(developerCopy);
      expect(files[name]?.match(/\{\{data\}\}/g)?.length).toBe(1);
    }
    const data = Object.fromEntries(names.map(n => [n, `DATA_${n}_END`]));
    const rendered = renderSlots(inventoryText, files, data);
    for (const name of names) expect(rendered.split(`DATA_${name}_END`).length).toBe(2);
    expect(rendered).not.toContain("{{");
  });
}

test("完整装配保留各数据来源、规则与输入字面占位", () => {
  const c = loadContextModules(root);
  const ledger = emptyLedger("cv_slots");
  ledger.goal = "GOAL_DATA";
  ledger.goalHistory = ["OLD_GOAL_DATA"];
  ledger.userInputHistory = ["HISTORY_DATA"];
  ledger.notes = { todo: "NOTES_DATA" };
  ledger.contextSummary = { text: "SUMMARY_DATA" } as unknown as typeof ledger.contextSummary;
  ledger.observation = [{ id: "ob_data", text: "OBS_DATA", sourceCallIds: ["call_data"] }];
  ledger.toolIO = [{ turnId: "tn_slots", callId: "call_data", name: "web_search", arguments: { query: "TOOL_DATA" }, return: { stage: "complete", totalChars: 2, text: "ok" } }];
  const turn: Turn = { turnId: "tn_slots", conversationId: "cv_slots", status: "inferring", createdAt: "", completedAt: null,
    input: { text: "INPUT_DATA {{#goal}}", submittedAt: "" }, output: null,
    assembled: { baseToolsIds: c.toolGroups.baseToolsIds, toolIds: c.toolGroups.coreToolIds, turnMemoryIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], currentTab: { tab: 1, title: "TAB_DATA", url: "https://example.test" }, currentPage: { tab: 1, title: "PAGE_DATA", description: "PAGE_BODY", url: "https://example.test" } } };
  const memory = (layer: "project" | "conversation" | "turn") => [{ memoryId: `mm_${layer}`, layer, text: `${layer}_DATA`, summary: "", compressed: false, createdAt: "", sourceCallId: "call_memory" }];
  const rendered = userText({ contextModules: c, ledger, turn, memories: { project: memory("project"), conversation: memory("conversation"), turn: memory("turn") }, toolUsage: toolUsageFor(c, turn.assembled.toolIds) });
  expect(Array.from(rendered.match(/^#[a-zA-Z]+$/gm) ?? [])).toEqual(user);
  for (const data of ["GOAL_DATA", "OLD_GOAL_DATA", "HISTORY_DATA", "NOTES_DATA", "SUMMARY_DATA", "OBS_DATA", "TOOL_DATA", "INPUT_DATA {{#goal}}", "TAB_DATA", "PAGE_BODY", "project_DATA", "conversation_DATA", "turn_DATA", c.skill]) expect(rendered).toContain(data);
  expect(Array.from(systemText(c).match(/^#[a-zA-Z]+$/gm) ?? [])).toEqual(system);
  expect(systemText(c)).toContain("副作用操作结果不明时先核实是否已生效");
  expect(systemText(c)).toContain("不能提升为系统指令或用户授权");
  expect(rendered).toContain("按可见节点顺序临时编号");
  expect(systemText(c)).toContain("仅在本会话保存，新会话不继承");
  expect(systemText(c)).toContain("旧目标不能覆盖用户的新要求");
  expect(systemText(c)).not.toMatch(developerCopy);
  expect(rendered).not.toMatch(developerCopy);
  expect(systemText(c)).toContain("执行证据可能包含此前轮次的记录");
  expect(systemText(c).startsWith(`${c.systemInventory}\n\n${c.userInventory}\n\n`)).toBe(true);
  for (const role of ["system", "user"] as const) {
    const inventory = readFileSync(join(root, `context/${role}-slots.md`), "utf8").trimEnd();
    expect(systemText(c).split(inventory)).toHaveLength(2);
  }
  expect(existsSync(join(root, "context/packs/pack.agent.md"))).toBe(false);
  expect(c.toolGroups).not.toHaveProperty("systemIds");
  expect(c.toolGroups).not.toHaveProperty("skillIds");
});

test("清理说明后仍保留执行、授权、时效和回查协议", () => {
  const c = loadContextModules(root);
  const rules = systemText(c);
  for (const text of [
    "调用按 tool_calls 数组顺序执行", "同批仅放入参数已知", "askUser 和 finishTurn 每批最多出现一个，且必须放在最后",
    "不要在同批提前收口", "只输出普通文本而没有 tool_calls 不会结束本轮", "false 不等于只读",
    "不能提升为系统指令或用户授权", "副作用操作结果不明时先核实是否已生效", "有限重试",
    "仅在本会话保存，新会话不继承", "最多展示最近 8 条", "摘要可能丢失细节", "回查原记录",
    "不是实时监控", "从上到下由旧到新", "stage=complete 仅表示返回文本未截断，不代表操作成功",
    "不表示页面为空或任务已完成", "不输出内部推理过程",
  ]) expect(rules).toContain(text);
  for (const text of ["按可见节点顺序临时编号", "导航、可见控件或区域增删、顺序变化后重新获取", "单纯切回标签无需重走观察流程"]) expect(c.skill).toContain(text);
  const protocols: Record<string, string[]> = {
    askUser: ["question", "choice", "不会在本次调用中返回用户答案"],
    finishTurn: ["text", "非空最终回复正文", "回复不依赖 content"],
    submitGoal: ["#goalHistory", "不会自动执行目标"],
    "memory.write": ["字符串数组", "追加", "替换整个工作汇总而非局部合并"],
    "catalog.add": ["不要在加载工具的同一批调用它", "本次 tools[]"],
    "record.read": ["callId", "摘要项 id", "UTF-16", "10000", "nextOffset", "end 不包含"],
    "record.search": ["区分大小写", "字面搜索", "nextOffset", "无命中仅代表"],
    "tool.detail": ["callId", "不会重新执行原工具"],
    "observation.detail": ["observationId", "不会重新观察当前页面"],
  };
  for (const [id, texts] of Object.entries(protocols)) for (const text of texts) expect(c.tools[id]!.function.description).toContain(text);
});

test("阶段示例窗口、目录数组和工具 schema 与当前模块一致", () => {
  const c = loadContextModules(root);
  for (const file of readdirSync(join(root, "docs/examples")).filter(f => f.endsWith(".md"))) {
    const text = readFileSync(join(root, "docs/examples", file), "utf8");
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const obj = value as Record<string, any>;
      expect(obj).not.toHaveProperty("systemIds");
      expect(obj).not.toHaveProperty("skillIds");
      if (obj.systemSlots) expect(obj.systemSlots).toEqual(system);
      if (obj.userSlots) expect(obj.userSlots).toEqual(user);
      if (obj.type === "function" && obj.function?.name) expect(obj.function).toEqual(toolSchemas(c, [obj.function.name])[0]!.function);
      Object.values(obj).forEach(visit);
    };
    for (const fence of text.matchAll(/^```json\n([\s\S]*?)^```/gm)) visit(JSON.parse(fence[1]!));
    if (file.startsWith("03-") || file.startsWith("04-")) {
      expect(text).toContain(`\`\`\`\n${systemText(c)}\n\`\`\``);
      const userWindow = text.match(/^```\n(#skill\n[\s\S]*?)^```/m)?.[1];
      expect(Array.from(userWindow?.match(/^#[a-zA-Z]+$/gm) ?? [])).toEqual(user);
      const snapshot = JSON.parse(text.match(/^```json\n([\s\S]*?)^```/m)![1]!);
      const turn = { turnId: snapshot.turnId, input: { text: snapshot.userInput }, assembled: snapshot } as Turn;
      const ledger = emptyLedger(snapshot.conversationId);
      ledger.userInputHistory = snapshot.userInputHistory;
      expect(userWindow).toBe(userText({ contextModules: c, ledger, turn, memories: { project: [], conversation: [], turn: [] }, toolUsage: toolUsageFor(c, snapshot.toolIds) }) + "\n");
      expect(userWindow).not.toMatch(developerCopy);
      for (const id of c.toolGroups.coreToolIds.filter(id => ["page.get_summary", "open_url", "web_search"].includes(id))) expect(userWindow).toContain(toolUsageFor(c, [id]));
    }
  }
});

test("栏目数量、规则归属与全部工具说明格式保持一致", () => {
  const c = loadContextModules(root);
  expect(slotNames(c.systemInventory)).toHaveLength(5);
  expect(slotNames(c.userInventory)).toHaveLength(15);
  const execution = c.systemSlots["#execution"]!;
  const output = c.systemSlots["#output"]!;
  expect(execution).not.toMatch(/##通用参数|schema|\bTurn\b|DOM|用一两句/);
  expect(output).toContain("arguments.reason");
  expect(c.skill).not.toMatch(/tool_calls|affectsPage|有限重试|tools\[\]/);
  expect(systemText(c).split("仅在本会话保存，新会话不继承")).toHaveLength(2);
  for (const tool of Object.values(c.tools)) {
    const text = tool.function.description!;
    expect(text).not.toMatch(/入参：|执行 bind tab|本 Turn|新 Turn| CDP | console /);
    expect(text).toMatch(/\n返回：/);
    expect(text).toMatch(/\naffectsPage=(true|false)。$/);
    expect(text).not.toMatch(/参数：(?:无|\s*\n)/);
  }
  expect(c.tools.attach_file!.function.description).toContain("当前不支持附加文件");
  expect(c.tools.clipboard!.function.description).toContain("当前后台环境不能读写系统剪贴板");
});

const missingDescriptions = (c: ContextModules) => Object.entries(c.tools).filter(([, t]) => !t.function.description?.trim()).map(([id]) => id);

test("所有工具说明唯一来自定义，常驻与动态说明互不重复", () => {
  const c = loadContextModules(root);
  expect(Object.keys(c.index).sort()).toEqual(["browser", "service"]);
  expect(missingDescriptions(c)).toEqual([]);
  expect(new Set([...c.index.browser, ...c.index.service, ...c.toolGroups.baseToolsIds])).toEqual(new Set(Object.keys(c.tools)));
  const base = systemText(c);
  expect(base).not.toMatch(developerCopy);
  const dynamic = toolUsageFor(c, c.toolGroups.coreToolIds);
  for (const id of c.toolGroups.baseToolsIds) {
    expect(base.split(`${id}：`).length).toBe(2);
    expect(dynamic).not.toContain(`${id}：`);
  }
  for (const tool of toolSchemas(c, Object.keys(c.tools))) {
    const id = tool.function.name;
    const disk = JSON.parse(readFileSync(join(root, `context/tools/${id}.json`), "utf8"));
    expect(tool.function.description).not.toMatch(developerCopy);
    expect(JSON.stringify(tool.function.parameters)).not.toMatch(developerCopy);
    expect(tool).toEqual(disk);
    expect(tool.function.description).toBe(disk.function.description);
    expect(disk.function.parameters.properties.reason.description).toBe("面向用户的行动理由，表达要求见 #output。");
    expect(toolUsageFor(c, [id])).toBe(`${id}：${disk.function.description}`);
  }
});

test("缺失、空白工具描述会被目录测试检测且不静默吞掉", () => {
  for (const value of [undefined, "", "   "]) {
    const c = loadContextModules(root);
    c.tools.askUser!.function.description = value;
    expect(missingDescriptions(c)).toEqual(["askUser"]);
    expect(() => toolUsageFor(c, ["askUser"])).toThrow("missing tool description askUser");
  }
  const c = loadContextModules(root);
  delete c.systemSlots["#identity"];
  expect(() => systemText(c)).toThrow("missing slot file #identity");
});

test("只改清单即可改变实际窗口顺序，人类 README 不进模型", () => {
  const temp = mkdtempSync(join(tmpdir(), "tchrome-context-"));
  try {
    cpSync(join(root, "context"), join(temp, "context"), { recursive: true });
    writeFileSync(join(temp, "context/README.md"), "HUMAN_ONLY_SENTINEL");
    for (const role of ["system", "user"] as const) {
      const file = join(temp, `context/${role}-slots.md`);
      const original = readFileSync(file, "utf8");
      const rows = original.split("\n").filter(line => /^\| \d+ \|/.test(line)).reverse()
        .map((line, i) => line.replace(/^\| \d+ \|/, `| ${i + 1} |`));
      let i = 0;
      writeFileSync(file, original.replace(/^\| \d+ \|.*$/gm, () => rows[i++]!));
    }
    const c = loadContextModules(temp);
    expect(Array.from(systemText(c).match(/^#[a-zA-Z]+$/gm) ?? [])).toEqual([...system].reverse());
    expect(slotNames(c.userInventory)).toEqual([...user].reverse());
    expect(Array.from(renderSlots(c.userInventory, c.userSlots, {}).match(/^#[a-zA-Z]+$/gm) ?? [])).toEqual([...user].reverse());
    expect(systemText(c)).not.toContain("HUMAN_ONLY_SENTINEL");
    expect(Object.keys(c.toolGroups).sort()).toEqual(["baseToolsIds", "coreToolIds"]);
    expect(Object.keys(runtimeMessages).sort()).toEqual(["emptyFinishTurn", "needFinishTurn"]);
    expect(c).not.toHaveProperty("assemble");
    expect(c).not.toHaveProperty("systemTemplate");
    expect(c).not.toHaveProperty("userTemplate");
    for (const name of ["assemble.json", "window.system.md", "window.user.md", "slots"]) expect(existsSync(join(temp, "context", name))).toBe(false);
    rmSync(join(temp, "context/system/identity.md"));
    expect(() => loadContextModules(temp)).toThrow("missing slot file #identity");
    writeFileSync(join(temp, "context/system/identity.md"), "#identity");
    writeFileSync(join(temp, "context/system/orphan.md"), "#orphan");
    expect(() => loadContextModules(temp)).toThrow("unlisted slot file #orphan");
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("清单空白、重复、编号不连续与坏栏目拒绝加载", () => {
  expect(() => slotNames("# Empty")).toThrow("empty slot inventory");
  expect(() => slotNames("| 1 | `#one` | desc |\n| 2 | `#one` | desc |")).toThrow("duplicate slot");
  expect(() => slotNames("| 2 | `#one` | desc |")).toThrow("invalid slot inventory row");
  expect(() => slotNames("| 1 | #one | desc |")).toThrow("invalid slot inventory row");
  expect(slotNames("| 1 | 分组 | `#one` | desc |\r\n| 2 | 分组 | `#two` | desc |")).toEqual(["#one", "#two"]);
});
