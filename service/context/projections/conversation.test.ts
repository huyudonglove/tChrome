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

test("stale notices only survive in the newest loop", () => {
  const ledger = emptyLedger("cv_01");
  ledger.loops = [
    { ...loop(1), runtime: [{ id: "rt_01", type: "notice", content: { kind: "reflect", text: "stale reminder" } }] },
    { ...loop(2), runtime: [{ id: "rt_02", type: "notice", content: { kind: "reflect", text: "current reminder" } }] },
  ];
  const ledgerCopy = JSON.stringify(ledger);
  const xml = conversationXml(project(ledger));
  expect(xml).toContain('<runtime id="rt_02" type="notice">');
  expect(xml).toContain("current reminder");
  expect(xml).not.toContain('id="rt_01"');
  expect(xml).not.toContain("stale reminder");
  expect(JSON.stringify(ledger)).toBe(ledgerCopy);
});

test("memory write calls project to pointers while the ledger keeps the original body", () => {
  const ledger = emptyLedger("cv_01");
  ledger.loops = [{ ...loop(1), helm: { finish: "tool_calls", id: "helm_01", content: "write", calls: [{ id: "call_07", name: "memory_writeConversation", arguments: { reason: "r", conversationMemory: ["secret text"] } }] } }];
  const projected = conversationPayload({ ledger, memories: { conversation: [] }, memoryPointers: { cv_01: { call_07: ["mm_09"] } } });
  expect(projected.loops[0]!.helm!.calls[0]!.arguments).toEqual({ reason: "r", memoryPointers: ["mm_09"] });
  expect(JSON.stringify(projected)).not.toContain("secret text");
  expect(ledger.loops[0]!.helm!.calls[0]!.arguments).toEqual({ reason: "r", conversationMemory: ["secret text"] });
});

test("memory update calls drop the rewritten body in favour of the pointer", () => {
  const ledger = emptyLedger("cv_01");
  ledger.loops = [{ ...loop(5), helm: { finish: "tool_calls", id: "helm_05", content: "update", calls: [{ id: "call_08", name: "memory_update", arguments: { reason: "r", memoryId: "mm_09", text: "rewritten body" } }] } }];
  const projected = conversationPayload({ ledger, memories: { conversation: [] }, memoryPointers: { cv_01: { call_08: ["mm_09"] } } });
  expect(projected.loops[0]!.helm!.calls[0]!.arguments).toEqual({ reason: "r", memoryId: "mm_09", memoryPointers: ["mm_09"] });
  expect(JSON.stringify(projected)).not.toContain("rewritten body");
  expect(ledger.loops[0]!.helm!.calls[0]!.arguments).toEqual({ reason: "r", memoryId: "mm_09", text: "rewritten body" });
});

test("pointers from another conversation never rewrite a same-numbered call", () => {
  const ledger = emptyLedger("cv_44");
  ledger.loops = [{ ...loop(1), helm: { finish: "tool_calls", id: "helm_01", content: "run", calls: [{ id: "call_69", name: "local_run", arguments: { reason: "r", filename: "probe.sh" } }] } }];
  // cv_32 的 call_69 写过记忆；同号但不同会话，这条调用必须原样保留。
  const projected = conversationPayload({ ledger, memories: { conversation: [] }, memoryPointers: { cv_32: { call_69: ["lm_10"] } } });
  expect(projected.loops[0]!.helm!.calls[0]!.arguments).toEqual({ reason: "r", filename: "probe.sh" });
  expect(JSON.stringify(projected)).not.toContain("memoryPointers");
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

test("local_replace_block drops its edit bodies once executed and keeps the file pointer", () => {
  const ledger = emptyLedger("cv_01");
  ledger.loops = [
    { ...loop(9), helm: { finish: "tool_calls", id: "helm_09", content: "edit", calls: [{ id: "call_11", name: "local_replace_block", arguments: { path: "/tmp/a.ts", search: "const a = 1", replace: "const a = 2" } }] } },
    { ...loop(10), runtime: [{ id: "rt_07", type: "callsResult", content: [{ callId: "call_11", name: "local_replace_block", result: { ok: true } }] }] },
  ];
  const projected = conversationPayload({ ledger, memories: { conversation: [] } });
  expect(projected.loops[0]!.helm!.calls[0]!.arguments).toEqual({ path: "/tmp/a.ts" });
  expect(ledger.loops[0]!.helm!.calls[0]!.arguments).toEqual({ path: "/tmp/a.ts", search: "const a = 1", replace: "const a = 2" });
});

test("write-disk calls that were never executed keep the full body", () => {
  const ledger = emptyLedger("cv_01");
  ledger.loops = [{ ...loop(8), helm: { finish: "tool_calls", id: "helm_08", content: "write", calls: [{ id: "call_10", name: "local_fs_write", arguments: { path: "/tmp/a.txt", content: "pending body" } }] } }];
  const projected = conversationPayload({ ledger, memories: { conversation: [] } });
  expect(projected.loops[0]!.helm!.calls[0]!.arguments).toEqual({ path: "/tmp/a.txt", content: "pending body" });
  expect(JSON.stringify(projected)).toContain("pending body");
});

test("helm default fields stay out of the window while diagnostics still render", () => {
  const ledger = emptyLedger("cv_01");
  ledger.loops = [
    { ...loop(1), helm: { finish: "tool_calls", id: "helm_01", content: "", calls: [], parseOk: true, schemaOk: true, faultCode: null, missing: [] } },
    // 用非 provider_ 的异常：provider 传输/协议失败的 loop 已整体不进窗口（另见下方专门用例）。
    { ...loop(2), helm: { finish: "error", id: "helm_02", content: "请求失败", calls: [], parseOk: false, schemaOk: false, faultCode: "invalid_arguments", missing: ["calls"] } },
  ];
  const xml = conversationXml(project(ledger));
  const defaults = xml.slice(xml.indexOf('<helm id="helm_01">'), xml.indexOf('<helm id="helm_02">'));
  expect(defaults).not.toContain("finish");
  expect(defaults).not.toContain("parseOk");
  expect(defaults).not.toContain("schemaOk");
  expect(defaults).not.toContain("faultCode");
  expect(defaults).not.toContain("missing");
  expect(xml).toContain('"finish":"error"');
  expect(xml).toContain('"faultCode":"invalid_arguments"');
  expect(xml).toContain('"parseOk":false');
  expect(xml).toContain('"schemaOk":false');
  expect(xml).toContain('"missing":["calls"]');
  expect(xml).toContain("请求失败");
});

test("userInput runtime keeps the text and drops the storage timestamp", () => {
  const ledger = emptyLedger("cv_01");
  ledger.loops = [{ ...loop(3), runtime: [{ id: "rt_03", type: "userInput", content: { text: "继续", submittedAt: "now" } }] }];
  const xml = conversationXml(project(ledger));
  expect(xml).toContain("继续");
  expect(xml).not.toContain("submittedAt");
});

test("only the newest loop carries a day-granularity date", () => {
  const ledger = emptyLedger("cv_01");
  // 本地时间构造：投影按本地时区取日期，断言不依赖运行环境时区。
  ledger.loops = [
    { ...loop(1), createdAt: new Date(2026, 9, 9, 8, 30).toISOString() },
    { ...loop(2), createdAt: new Date(2026, 9, 11, 9, 45).toISOString() },
  ];
  const xml = conversationXml(project(ledger));
  expect(xml).toContain('<loop id="loop_2" date="2026-10-11">');
  expect(xml).not.toContain("2026-10-09");
  expect(xml).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
});

test("the summaries block carries a persistent compression marker", () => {
  const ledger = emptyLedger("cv_01");
  ledger.loops = [loop(1)];
  const withSummary = conversationXml(conversationPayload({ ledger, memories: { conversation: [] },
    conversationSummaries: [{ id: "sum_01", loopIds: ["loop_01"], userRequest: "u", state: "s", constraints: [], pending: [], decisions: [] }] }));
  expect(withSummary).toContain("<summaries");
  expect(withSummary).toContain("已压缩为摘要");
  const withoutSummary = conversationXml(project(ledger));
  expect(withoutSummary).not.toContain("<summaries");
});

test("provider transport failures stay out of the window while tool failures still render", () => {
  const ledger = emptyLedger("cv_01");
  ledger.loops = [
    { ...loop(1), helm: { finish: "error", id: "helm_01", content: "", calls: [], parseOk: false, schemaOk: false, faultCode: "provider_invalid_response", missing: ["calls"] } },
    { ...loop(2), helm: { finish: "error", id: "helm_02", content: "bad args", calls: [], parseOk: true, schemaOk: false, faultCode: "invalid_arguments", missing: [] } },
  ];
  const xml = conversationXml(project(ledger));
  // provider_ 前缀的传输/协议失败整体不进窗口。
  expect(xml).not.toContain("provider_invalid_response");
  expect(xml).not.toContain('id="loop_1"');
  // 模型可自纠的失败仍完整渲染，诊断线索不丢。
  expect(xml).toContain("invalid_arguments");
  expect(xml).toContain("bad args");
  expect(ledger.loops).toHaveLength(2);
});
