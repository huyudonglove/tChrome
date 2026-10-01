import { describe, expect, test } from "bun:test";

import { conversationXml, type ConversationPayload } from "./conversation.ts";

const payload = (extra: Partial<ConversationPayload>): ConversationPayload =>
  ({
    reflectionStatus: null,
    conversationMemory: [],
    conversationHistorySummary: [],
    turns: [],
    toolRange: null,
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