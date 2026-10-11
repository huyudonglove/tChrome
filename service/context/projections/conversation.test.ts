import { expect, test } from "bun:test";
import { emptyLedger } from "../../runtime/store.ts";
import type { LoopRecord } from "../../types.ts";
import { conversationPayload, conversationXml } from "./conversation.ts";

const loop = (id: number): LoopRecord => ({ id: `loop_${id}`, conversationId: "cv_01", turnId: "tn_01", createdAt: "now", runtime: [] });
const project = (ledger: ReturnType<typeof emptyLedger>) => conversationPayload({ ledger, memories: { conversation: [] } });

test("loop inputs and response retain separate identities; only unfinished tasks occupy the suffix", () => {
  const ledger = emptyLedger("cv_01");
  ledger.loops = [{ ...loop(1), runtime: [{ id: "rt_01", type: "userInput", content: "fix it" }, { id: "rt_02", type: "notice", content: { text: "check result", scope: "loop" } }], helm: { finish: "tool_calls", id: "helm_01", content: "checking", calls: [] } }];
  ledger.tasks = [{ id: "task_01", status: "active", items: [], createdAt: "", updatedAt: "" }, { id: "task_02", status: "completed", items: [], createdAt: "", updatedAt: "" }];
  const xml = conversationXml(project(ledger));
  expect(xml).toContain('<runtime id="rt_01" type="userInput">');
  expect(xml).toContain('<runtime id="rt_02" type="notice">');
  expect(xml).toContain('<helm id="helm_01">');
  expect(xml.indexOf("<tasks>")).toBeGreaterThan(xml.indexOf("</loop>"));
  expect(xml).toContain('id="task_01"');
  expect(xml).not.toContain("task_02");
  expect(xml).not.toMatch(/<(?:turn|notes|workspaces|observations|reflections|queries|runtimeNotices)\b/);
});

test("all loop results and paired calls stay visible without retention filtering", () => {
  const ledger = emptyLedger("cv_01");
  ledger.loops = [
    { ...loop(1), helm: { finish: "tool_calls", id: "helm_01", content: "read", calls: [{ id: "call_01", name: "local_fs_read", arguments: {} }, { id: "call_02", name: "local_fs_read", arguments: {} }] } },
    { ...loop(2), runtime: [{ id: "rt_02", type: "callsResult", content: [{ callId: "call_01", name: "local_fs_read", result: { text: "temporary" } }, { callId: "call_02", name: "local_fs_read", result: { text: "retained" } }] }], helm: { finish: "tool_calls", id: "helm_02", content: "next", calls: [{ id: "call_03", name: "local_fs_read", arguments: {} }] } },
    { ...loop(3), runtime: [{ id: "rt_03", type: "callsResult", content: [{ callId: "call_03", name: "local_fs_read", result: { ok: false, error: "denied" } }] }] },
  ];
  const projected = project(ledger);
  expect(projected.loops[0]!.helm!.calls.map(row => row.id)).toEqual(["call_01", "call_02"]);
  expect(projected.loops[1]!.helm!.calls.map(row => row.id)).toEqual(["call_03"]);
  const xml = conversationXml(projected);
  expect(xml).toContain("temporary");
  expect(xml).toContain("retained");
  expect(xml).toContain("denied");
  expect(ledger.loops[0]!.helm!.calls).toHaveLength(2);
  ledger.loops.push({ ...loop(4), runtime: [
    { id: "rt_04", type: "userInput", content: "continue" },
    { id: "rt_05", type: "notice", content: { kind: "budget", text: "current only", scope: "loop" } },
  ] });
  const afterInput = project(ledger);
  expect(afterInput.loops[1]!.helm!.calls.map(row => row.id)).toEqual(["call_03"]);
  const nextXml = conversationXml(afterInput);
  expect(nextXml).toContain("denied");
  expect(nextXml).toContain("call_03");
  expect(nextXml).toContain("retained");
  expect(ledger.loops[1]!.helm!.calls).toHaveLength(1);
});

test("memory write calls project to pointers while the ledger keeps the original body", () => {
  const ledger = emptyLedger("cv_01");
  ledger.loops = [{ ...loop(1), helm: { finish: "tool_calls", id: "helm_01", content: "write", calls: [{ id: "call_07", name: "memory_writeConversation", arguments: { reason: "r", conversationMemory: ["secret text"] } }] } }];
  const projected = conversationPayload({ ledger, memories: { conversation: [] }, memoryPointers: { call_07: ["mm_09"] } });
  expect(projected.loops[0]!.helm!.calls[0]!.arguments).toEqual({ reason: "r", memoryPointers: ["mm_09"] });
  expect(JSON.stringify(projected)).not.toContain("secret text");
  expect(ledger.loops[0]!.helm!.calls[0]!.arguments).toEqual({ reason: "r", conversationMemory: ["secret text"] });
});

test("memory update calls drop the rewritten body in favour of the pointer", () => {
  const ledger = emptyLedger("cv_01");
  ledger.loops = [{ ...loop(5), helm: { finish: "tool_calls", id: "helm_05", content: "update", calls: [{ id: "call_08", name: "memory_update", arguments: { reason: "r", memoryId: "mm_09", text: "rewritten body" } }] } }];
  const projected = conversationPayload({ ledger, memories: { conversation: [] }, memoryPointers: { call_08: ["mm_09"] } });
  expect(projected.loops[0]!.helm!.calls[0]!.arguments).toEqual({ reason: "r", memoryId: "mm_09", memoryPointers: ["mm_09"] });
  expect(JSON.stringify(projected)).not.toContain("rewritten body");
  expect(ledger.loops[0]!.helm!.calls[0]!.arguments).toEqual({ reason: "r", memoryId: "mm_09", text: "rewritten body" });
});

test("write-disk calls drop the bulky body once executed while keeping the file pointer", () => {
  const ledger = emptyLedger("cv_01");
  ledger.loops = [
    { ...loop(6), helm: { finish: "tool_calls", id: "helm_06", content: "write", calls: [{ id: "call_09", name: "script_write", arguments: { filename: "probe.py", code: "print('long body')" } }] } },
    { ...loop(7), runtime: [{ id: "rt_06", type: "callsResult", content: [{ callId: "call_09", name: "script_write", result: { ok: true } }] }] },
  ];
  const projected = conversationPayload({ ledger, memories: { conversation: [] } });
  expect(projected.loops[0]!.helm!.calls[0]!.arguments).toEqual({ filename: "probe.py" });
  expect(JSON.stringify(projected)).not.toContain("long body");
  expect(ledger.loops[0]!.helm!.calls[0]!.arguments).toEqual({ filename: "probe.py", code: "print('long body')" });
});

test("write-disk calls that were never executed keep the full body", () => {
  const ledger = emptyLedger("cv_01");
  ledger.loops = [{ ...loop(8), helm: { finish: "tool_calls", id: "helm_08", content: "write", calls: [{ id: "call_10", name: "local_fs_write", arguments: { path: "/tmp/a.txt", content: "pending body" } }] } }];
  const projected = conversationPayload({ ledger, memories: { conversation: [] } });
  expect(projected.loops[0]!.helm!.calls[0]!.arguments).toEqual({ path: "/tmp/a.txt", content: "pending body" });
  expect(JSON.stringify(projected)).toContain("pending body");
});
