import { afterEach, expect, test } from "bun:test";
import { shouldSubmitOnEnter, stopCurrentSession } from "./interactions";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function setupStop() {
  const replies: Array<(response: Response) => void> = [];
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Promise<Response>((resolve) => replies.push(resolve));
  }) as unknown as typeof fetch;
  const submission = { current: 1 };
  const switching = { current: false };
  let visible = "A running";
  const errors: unknown[] = [];
  const stop = () => stopCurrentSession<{ label: string }>({
    conversationId: visible.split(" ")[0]!,
    submission, switching,
    onStopped: (session) => { visible = session.label; },
    onError: (error) => errors.push(error),
  });
  return {
    submission, switching, errors, stop, bodies,
    respond: (index: number, body: Record<string, unknown>, status = 200) => replies[index]!(Response.json(
      status === 200 ? { conversationId: "A", status: "paused", messages: [], ...body } : body, { status })),
    switchToB: () => { submission.current++; visible = "B idle"; },
    visible: () => visible,
    requests: () => replies.length,
  };
}

test("delayed stop cannot restore the old session after switching conversations", async () => {
  const fixture = setupStop();
  const pending = fixture.stop();
  fixture.switchToB();
  expect(fixture.bodies).toEqual([{ conversationId: "A" }]);
  fixture.respond(0, { label: "A paused" });
  await pending;
  expect(fixture.visible()).toBe("B idle");
  expect(fixture.submission.current).toBe(2);
  expect(fixture.errors).toEqual([]);
});

test("current stop is applied once and invalidates duplicate in-flight stop responses", async () => {
  const fixture = setupStop();
  const first = fixture.stop();
  const duplicate = fixture.stop();
  fixture.respond(0, { label: "A paused" });
  await first;
  expect(fixture.visible()).toBe("A paused");
  expect(fixture.submission.current).toBe(2);
  fixture.respond(1, { label: "outdated duplicate" });
  await duplicate;
  expect(fixture.visible()).toBe("A paused");
});

test("stop is ignored during a switch and stale failures do not affect the new session", async () => {
  const fixture = setupStop();
  fixture.switching.current = true;
  await fixture.stop();
  expect(fixture.requests()).toBe(0);
  fixture.switching.current = false;
  const pending = fixture.stop();
  fixture.switchToB();
  fixture.respond(0, { error: "old failure" }, 500);
  await pending;
  expect(fixture.visible()).toBe("B idle");
  expect(fixture.errors).toEqual([]);
});

test("current stop errors preserve the session and report the server failure", async () => {
  const fixture = setupStop();
  const pending = fixture.stop();
  fixture.respond(0, { error: "stop unavailable" }, 500);
  await pending;
  expect(fixture.visible()).toBe("A running");
  expect(fixture.submission.current).toBe(1);
  expect(fixture.errors[0]).toMatchObject({
    faultCode: "service_http_error", details: { status: 500, body: { error: "stop unavailable" } },
  });
});

test("Enter submits only after IME composition ends; Shift+Enter keeps a newline", () => {
  const event = { key: "Enter", shiftKey: false, nativeEvent: { isComposing: false, keyCode: 13 } };
  expect(shouldSubmitOnEnter(event)).toBe(true);
  expect(shouldSubmitOnEnter({ ...event, nativeEvent: { isComposing: true, keyCode: 13 } })).toBe(false);
  expect(shouldSubmitOnEnter({ ...event, nativeEvent: { isComposing: false, keyCode: 229 } })).toBe(false);
  expect(shouldSubmitOnEnter({ ...event, shiftKey: true })).toBe(false);
  expect(shouldSubmitOnEnter({ ...event, key: "a" })).toBe(false);
});
