import { describe, expect, test } from "bun:test";
import { emptyLedger } from "../../runtime/store.ts";
import { runtimeConfig } from "../../config/runtime.ts";
import type { ToolIOItem, Turn } from "../../types.ts";

import { conversationPayload, conversationXml, type ConversationPayload } from "./conversation.ts";

const payload = (extra: Partial<ConversationPayload>): ConversationPayload =>
  ({
    conversationMemory: [],
    conversationHistorySummary: [],
    turns: [],
    ...extra,
  }) as unknown as ConversationPayload;

describe("<task> 会话级任务标签", () => {
  test("renders <task> at session root level alongside turns", () => {
    const sampleTask = {
      id: "task_01",
      title: "测试任务",
      status: "active" as const,
      createdTurnId: "tn_01",
      updatedTurnId: "tn_01",
      items: [
        { id: "item_01", text: "步骤1", status: "doing" as const },
      ],
    };
    const xml = conversationXml(payload({
      task: sampleTask,
      turns: [{
        turnId: "tn_01",
        userInput: { id: "input_01", turnId: "tn_01", userInput: "hello" },
        callBounds: null, calls: [],
        observations: [], workspace: [],
        notes: {},
        reflection: null,
        query: [],
        stopReason: null,
      }],
    }));

    // <task> 在外层顶层渲染且直接为任务实体（无 events 流水）
    // 标量元数据上提为属性，属性名带引号与等号，字段本身不丢
    expect(xml).toContain('<tasks start="task_01" end="task_01">');
    expect(xml).toContain('<task id="task_01"');
    expect(xml).toContain('status="active"');
    expect(xml).toContain('<item id="item_01" status="doing">');
    // 非属性键仍留在正文，属性化只搬位置不删字段
    expect(xml).toContain('{"text":"步骤1"}');
    expect(xml).not.toContain('"id": "task_01"');
    expect(xml).not.toContain('"events"');
    // <turn> 内不应嵌套 <task>
    const turnContent = xml.slice(xml.indexOf("<turn "), xml.indexOf("</turn>"));
    expect(turnContent).not.toContain("<task>");
  });

  test("omits <task> entirely when session has no task", () => {
    const xml = conversationXml(payload({ task: null }));
    expect(xml).not.toContain("<tasks>");
  });
});
describe("conversation workspace evidence", () => {
  const turnBase = {
    turnId: "tn_01",
    userInput: { id: "input_01", turnId: "tn_01", userInput: "hello" },
    callBounds: null, calls: [], observations: [], notes: {}, reflection: null, query: [], stopReason: null,
  };
  test("groups evidence from multiple turns at conversation level and preserves sources", () => {
    const xml = conversationXml(payload({
      task: null,
      turns: [
        { ...turnBase, workspace: [{ id: "ws01", turnId: "tn_01", boundId: "b02", callId: "call_03", callIds: ["call_03"], target: { kind: "file", key: "/src/auth.ts" }, op: "local_fs_read", result: { ok: true }, content: "token check", files: ["/src/auth.ts"] }] },
        { ...turnBase, turnId: "tn_02", workspace: [{ id: "ws02", turnId: "tn_02", boundId: "b03", callId: "call_05", callIds: ["call_05"], target: { kind: "file", key: "/src/auth.ts" }, op: "local_fs_write", result: { ok: true }, content: "updated check", mutation: true, files: ["/src/auth.ts"] }] },
      ],
    }));
    const turns = [...xml.matchAll(/<turn\b[^>]*>([\s\S]*?)<\/turn>/g)];
    expect(turns).toHaveLength(2);
    expect(turns.every(turn => !turn[1]!.includes("<workspace"))).toBe(true);
    expect(xml).toContain("/src/auth.ts");
    expect(xml).toContain("token check");
    expect(xml).toContain("updated check");
    expect(xml).toContain('"sources"');
    expect(xml).toContain('"callId":"call_03"');
    expect(xml).toContain('"callId":"call_05"');
  });

  test("omits workspace when there is no evidence", () => {
    const xml = conversationXml(payload({ task: null, turns: [{ ...turnBase, workspace: [] }] }));
    expect(xml).not.toContain("<workspace");
  });
});

test("projects record IDs into note/query attributes and matching container bounds", async () => {
  const { queryView } = await import("./queries.ts");
  const query = {
    queryId: "query_03", turnId: "tn_01", sumId: "sum_01", module: "toolIO",
    intent: "核对来源", status: "complete" as const, records: [],
  };
  for (const inlineChars of [10000, 1]) {
    const xml = conversationXml(payload({
      turns: [{
        turnId: "tn_01",
        userInput: { id: "input_01", turnId: "tn_01", userInput: "hello" },
        callBounds: null, calls: [], observations: [], workspace: [], reflection: null, stopReason: null,
        notes: { draft: { id: "nt_04", value: "待核实" }, result: { id: "nt_07", value: "已完成" } },
        query: [queryView(query, { inlineChars })],
      }],
    }));
    expect(xml).toContain('<notes start="nt_04" end="nt_07">');
    expect(xml).toContain('<note id="nt_04" key="draft">\n待核实\n</note>');
    expect(xml).toContain('<note id="nt_07" key="result">\n已完成\n</note>');
    expect(xml).toContain('<queries start="query_03" end="query_03">');
    expect(xml).toContain('<query id="query_03"');
    expect(xml).not.toContain('"queryId"');
  }
});

test("externalized query preserves its status and error detail without inventing success", async () => {
  const { queryView } = await import("./queries.ts");
  const query = { queryId: "query_01", turnId: "tn_01", sumId: "sum_01", module: "toolIO", intent: "核对", status: "error" as const, detail: "查询失败", records: [] };
  const view = queryView(query, { inlineChars: 1 });
  expect(view).toMatchObject({ externalized: true, status: "error", detail: "查询失败" });
  expect(view).not.toHaveProperty("ok");
});

describe("per-turn call retention", () => {
  const call = (id: number, turnId: string, batchId: string, keepInCalls?: boolean): ToolIOItem => ({
    callId: `call_${String(id).padStart(2, "0")}`, turnId, batchId, name: "local_fs_read",
    arguments: { path: `/source/${id}.ts`, ...(keepInCalls === undefined ? {} : { keepInCalls }) },
    return: { stage: "complete", text: '{"ok":true}', totalChars: 11 },
  });
  const fixture = () => {
    const ledger = emptyLedger("cv_01");
    ledger.userInputHistory = [{ id: "input_01", turnId: "tn_01", userInput: "earlier", submittedAt: "now" }];
    ledger.toolIO = [
      call(1, "tn_01", "batch_01", false), call(2, "tn_01", "batch_01", true),
      call(3, "tn_01", "batch_01"), call(4, "tn_02", "batch_02", true),
      call(5, "tn_02", "batch_02", false), call(6, "tn_02", "batch_03", false),
      call(7, "tn_02", "batch_03"),
    ];
    ledger.lastAction = { turnId: "tn_02", batchId: "batch_03", calls: ledger.toolIO.slice(-2).map(row => ({ callId: row.callId, name: row.name })) };
    const turn: Turn = {
      turnId: "tn_02", conversationId: "cv_01", status: "inferring", createdAt: "now", completedAt: null, stopReason: null,
      input: { id: "input_02", text: "current", submittedAt: "now" },
      assembled: { baseToolsIds: [], toolIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], currentPage: null, currentTabs: { ok: true, windows: [] }, observations: [], workspace: [] },
    };
    const project = () => conversationPayload({ ledger, turn, memories: { conversation: [] }, gate: { inlineChars: runtimeConfig.results.inlineChars } });
    return { ledger, turn, project };
  };

  test("keeps explicit historical calls and the entire latest live batch inside their own turns", () => {
    const { ledger, project } = fixture();
    const source = JSON.stringify(ledger.toolIO);
    const result = project();
    expect(result.turns.map(turn => turn.calls.map(call => call.callId))).toEqual([["call_02"], ["call_04", "call_06", "call_07"]]);
    expect(result.turns.map(turn => turn.callBounds)).toEqual([
      { from: "call_01", to: "call_03", kept: 1, total: 3 },
      { from: "call_04", to: "call_07", kept: 3, total: 4 },
    ]);
    const xml = conversationXml(result);
    const turns = [...xml.matchAll(/<turn\b[^>]*>([\s\S]*?)<\/turn>/g)];
    expect(turns[0]![1]).toContain('<calls start="call_01" end="call_03" kept="1" total="3">');
    expect(turns[0]![1]).toContain('callId="call_02"');
    expect(turns[0]![1]).not.toContain('callId="call_06"');
    expect(turns[1]![1]).toContain('callId="call_06"');
    expect(xml.slice(xml.lastIndexOf("</turn>") + 7)).not.toContain("<calls");
    expect(JSON.stringify(ledger.toolIO)).toBe(source);
    expect(result).not.toHaveProperty("toolIO");
    expect(result).not.toHaveProperty("toolIOBounds");
  });

  test("visible calls reference complete workspace evidence while retaining outcome status", () => {
    const { ledger, turn, project } = fixture();
    const row = ledger.toolIO.at(-1)!;
    row.return.text = '{"ok":false,"error":"read denied"}';
    turn.assembled.workspace.push({
      id: "ws01", turnId: turn.turnId, boundId: "b03", callId: row.callId, callIds: [row.callId],
      target: { kind: "file", key: "/source/7.ts" }, op: "local_fs_read", result: { ok: false, error: "read denied" },
    });
    const result = project();
    const projected = result.turns[1]!.calls.find(call => call.callId === row.callId)!;
    expect(projected.return.result).toEqual({ ok: false, workspaceIds: ["ws01"] });
    expect(projected).not.toHaveProperty("args");
    expect(conversationXml(result)).toContain("read denied");
    expect(row.return.text).toBe('{"ok":false,"error":"read denied"}');
  });

  test("a bookkeeping batch replaces one-time call visibility and preserves pointer mapping", () => {
    const { ledger, project } = fixture();
    ledger.toolIO.push({ ...call(8, "tn_02", "batch_04", false), name: "notes_write", arguments: { keepInCalls: false, reason: "记录", key: "read", value: "done" } });
    ledger.lastAction = { turnId: "tn_02", batchId: "batch_04", calls: [{ callId: "call_08", name: "notes_write" }] };
    const live = project().turns[1]!;
    expect(live.calls.map(call => call.callId)).toEqual(["call_04", "call_08"]);
    expect(live.calls[1]).not.toHaveProperty("args");
    expect(live.calls[1]!.return.result).toEqual({ ok: true, note: "read" });
    expect(live.callBounds).toEqual({ from: "call_04", to: "call_08", kept: 2, total: 5 });
  });

  test("history has no latest-batch exception and an empty view retains its original bounds", () => {
    const { ledger, project } = fixture();
    ledger.toolIO = ledger.toolIO.filter(call => call.arguments.keepInCalls !== true);
    ledger.lastAction = { turnId: "tn_01", batchId: "batch_01", calls: [{ callId: "call_01", name: "local_fs_read" }] };
    const result = project();
    expect(result.turns.every(turn => turn.calls.length === 0)).toBe(true);
    const xml = conversationXml(result);
    expect(xml).toContain('<turn turnId="tn_01" start="call_01" end="call_03">');
    expect(xml).toContain('<turn turnId="tn_02" start="call_05" end="call_07">');
    expect(xml).not.toContain("<calls");
  });

  test("explicit retained calls have no count cap and only remaining source rows are projected", () => {
    const { ledger, project } = fixture();
    ledger.toolIO = Array.from({ length: 150 }, (_, i) => call(i + 1, "tn_01", "batch_01", true));
    expect(project().turns[0]!.calls).toHaveLength(150);
    ledger.toolIO = ledger.toolIO.slice(100);
    const historical = project().turns[0]!;
    expect(historical.calls).toHaveLength(50);
    expect(historical.callBounds).toEqual({ from: "call_101", to: "call_150", kept: 50, total: 50 });
  });
});
