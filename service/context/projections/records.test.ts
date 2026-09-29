import { describe, expect, test } from "bun:test";

import type { Observation } from "../../types.ts";
import { pageView } from "./records.ts";

const base: Observation = {
  id: "page_01",
  turnId: "tn_05",
  observedAt: "2026-09-29T07:00:00.000Z",
  callId: "call_10",
  type: "page.get_summary",
  result: "title: demo",
};

describe("pageView observation expiry", () => {
  test("keeps writtenTurn and validUntilTurn visible to the model", () => {
    const view = pageView({ ...base, writtenTurn: 5, validUntilTurn: 6 }, 5);
    expect(view?.writtenTurn).toBe(5);
    expect(view?.validUntilTurn).toBe(6);
  });

  test("no validUntilTurn means the observation never expires", () => {
    const view = pageView({ ...base, writtenTurn: 1 }, 40);
    expect(view).not.toBeNull();
    expect(view).not.toHaveProperty("stale");
  });

  test("still inside the window on the last valid turn", () => {
    const view = pageView({ ...base, writtenTurn: 5, validUntilTurn: 6 }, 6);
    expect(view).not.toBeNull();
    expect(view?.result).toBe("title: demo");
  });

  test("one turn past the window is no longer injected", () => {
    expect(pageView({ ...base, writtenTurn: 5, validUntilTurn: 6 }, 7)).toBeNull();
  });

  test("long past the window stays dropped", () => {
    expect(pageView({ ...base, writtenTurn: 5, validUntilTurn: 6 }, 21)).toBeNull();
  });

  test("missing currentTurn (legacy callers) keeps the observation", () => {
    const view = pageView({ ...base, writtenTurn: 5, validUntilTurn: 6 });
    expect(view).not.toBeNull();
    expect(view?.id).toBe("page_01");
  });

  test("dropping never rewrites a still-valid observation", () => {
    const fresh = pageView({ ...base, writtenTurn: 5, validUntilTurn: 6 }, 6);
    const dropped = pageView({ ...base, writtenTurn: 5, validUntilTurn: 6 }, 9);
    expect(dropped).toBeNull();
    expect(fresh?.result).toBe("title: demo");
    expect(fresh?.callId).toBe("call_10");
    expect(fresh?.type).toBe("page.get_summary");
  });
});
