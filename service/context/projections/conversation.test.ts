import { describe, expect, test } from "bun:test";

import { conversationXml, type ConversationPayload } from "./conversation.ts";

const payload = (extra: Partial<ConversationPayload>): ConversationPayload =>
  ({
    conversationMemory: [],
    conversationHistorySummary: [],
    turns: [],
    toolIOBounds: null,
    toolIO: [],
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
        callBounds: null,
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
describe("<workspace> 因果工作区", () => {
  const turnBase = {
    turnId: "tn_01",
    userInput: { id: "input_01", turnId: "tn_01", userInput: "hello" },
    callBounds: null,
    observations: [],
    notes: {},
    reflection: null,
    query: [],
    stopReason: null,
  };
  test("renders <workspaces start end> with <workspace id boundid callIds> and op/value body", () => {
    const xml = conversationXml(payload({
      task: null,
      turns: [{ ...turnBase, workspace: [
        { id: "ws01", turnId: "tn_01", boundId: "b02", callId: "call_03", callIds: ["call_01", "call_02"], op: "读了列表接口", value: "分页参数是 cursor" },
        { id: "ws02", turnId: "tn_01", boundId: "b03", callId: "call_05", callIds: ["call_04"], op: "试了提交", value: "200 成功" },
      ] }],
    }));
    expect(xml).toContain('<workspaces start="ws01" end="ws02">');
    expect(xml).toContain('<workspace id="ws01" boundid="b02" callIds="call_01,call_02">');
    expect(xml).toContain('{"op":"读了列表接口","value":"分页参数是 cursor"}');
  });

  test("omits <workspace> entirely when the turn wrote nothing", () => {
    const xml = conversationXml(payload({ task: null, turns: [{ ...turnBase, workspace: [] }] }));
    expect(xml).not.toContain("<workspace");
  });

  test("renders files attribute when the entry names files", () => {
    const xml = conversationXml(payload({
      task: null,
      turns: [{ ...turnBase, workspace: [
        { id: "ws01", turnId: "tn_01", boundId: "b02", callId: "call_03", callIds: ["call_01"], op: "读了鉴权", value: "token 在此处校验", files: ["src/auth.ts:120-180"] },
      ] }],
    }));
    expect(xml).toContain('files="src/auth.ts:120-180"');
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
      runtime: [{ id: "rt_02", kind: "workspace", scope: "turn", text: "记录结论" }],
      turns: [{
        turnId: "tn_01",
        userInput: { id: "input_01", turnId: "tn_01", userInput: "hello" },
        callBounds: null, observations: [], workspace: [], reflection: null, stopReason: null,
        notes: { draft: { id: "nt_04", value: "待核实" }, result: { id: "nt_07", value: "已完成" } },
        query: [queryView(query, { inlineChars })],
      }],
    }));
    expect(xml).toContain('<notes start="nt_04" end="nt_07">');
    expect(xml).toContain('<note id="nt_04" key="draft">\n待核实\n</note>');
    expect(xml).toContain('<note id="nt_07" key="result">\n已完成\n</note>');
    expect(xml).toContain('<queries start="query_03" end="query_03">');
    expect(xml).toContain('<query id="query_03"');
    expect(xml).toContain('<notice id="rt_02" kind="workspace" scope="turn">');
    expect(xml).not.toContain('"queryId"');
  }
});
