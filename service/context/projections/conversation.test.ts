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

test("resolved retention keeps false results and paired calls only for the current request loop", () => {
  const ledger = emptyLedger("cv_01");
  ledger.loops = [
    { ...loop(1), helm: { finish: "tool_calls", id: "helm_01", content: "read", calls: [{ id: "call_01", name: "local_fs_read", arguments: {} }, { id: "call_02", name: "local_fs_read", arguments: {} }] } },
    { ...loop(2), runtime: [{ id: "rt_02", type: "callsResult", content: [{ callId: "call_01", name: "local_fs_read", result: { text: "temporary" }, keepInCalls: false }, { callId: "call_02", name: "local_fs_read", result: { text: "retained" }, keepInCalls: true }] }], helm: { finish: "tool_calls", id: "helm_02", content: "next", calls: [{ id: "call_03", name: "local_fs_read", arguments: {} }] } },
    { ...loop(3), runtime: [{ id: "rt_03", type: "callsResult", content: [{ callId: "call_03", name: "local_fs_read", result: { ok: false, error: "denied" }, keepInCalls: false }] }] },
  ];
  const projected = project(ledger);
  expect(projected.loops[0]!.helm!.calls.map(row => row.id)).toEqual(["call_02"]);
  expect(projected.loops[1]!.helm!.calls.map(row => row.id)).toEqual(["call_03"]);
  const xml = conversationXml(projected);
  expect(xml).not.toContain("temporary");
  expect(xml).toContain("retained");
  expect(xml).toContain("denied");
  expect(ledger.loops[0]!.helm!.calls).toHaveLength(2);
  ledger.loops.push({ ...loop(4), runtime: [
    { id: "rt_04", type: "userInput", content: "continue" },
    { id: "rt_05", type: "notice", content: { kind: "budget", text: "current only", scope: "loop" } },
  ] });
  const afterInput = project(ledger);
  expect(afterInput.loops[1]!.helm!.calls).toEqual([]);
  const nextXml = conversationXml(afterInput);
  expect(nextXml).not.toContain("denied");
  expect(nextXml).not.toContain("call_03");
  expect(nextXml).toContain("retained");
  expect(ledger.loops[1]!.helm!.calls).toHaveLength(1);
});
