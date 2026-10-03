import { describe, expect, test } from "bun:test";

import { conversationXml, type ConversationPayload } from "./conversation.ts";

const payload = (extra: Partial<ConversationPayload>): ConversationPayload =>
  ({
    reflectionStatus: null,
    conversationMemory: [],
    conversationHistorySummary: [],
    turns: [],
    toolIOBounds: null,
    toolIO: [],
    ...extra,
  }) as unknown as ConversationPayload;

describe("<reflectionStatus> 会话级反思状态行", () => {
  test("renders the session tally and the latest focus at the top of the module", () => {
    const xml = conversationXml(payload({ reflectionStatus: { count: 3, latestId: "rf_02", latestFocus: "证据边界" } }));
    expect(xml.startsWith("<reflectionStatus>")).toBe(true);
    expect(xml).toContain('"count": 3');
    expect(xml).toContain('"latestId": "rf_02"');
    expect(xml).toContain('"latestFocus": "证据边界"');
  });

  test("omits the tag entirely when the session has no reflection", () => {
    expect(conversationXml(payload({}))).not.toContain("reflectionStatus");
  });
});

describe("<task> 会话级任务插槽", () => {
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
        callRange: null,
        actions: null,
        observations: [],
        notes: null,
        reflection: null,
        query: [],
        stopReason: null,
      }],
    }));

    // <task> 在外层顶层渲染且直接为任务实体（无 events 流水）
    expect(xml).toContain("<task>\n");
    expect(xml).toContain('"id": "task_01"');
    expect(xml).toContain('"status": "active"');
    expect(xml).not.toContain('"events"');
    // <tn_01> 内不应嵌套 <task>
    const turnContent = xml.slice(xml.indexOf("<tn_01>"), xml.indexOf("</tn_01>"));
    expect(turnContent).not.toContain("<task>");
  });

  test("omits <task> entirely when session has no task", () => {
    const xml = conversationXml(payload({ task: null }));
    expect(xml).not.toContain("<task>");
  });
});