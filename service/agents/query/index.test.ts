import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { commitArchive } from "../../context-archive/store.ts";
import { queryContext } from "./index.ts";
import { queryTurnsFromUserMessage } from "./protocol.ts";
import type { CompressionRecord } from "../../context-archive/types.ts";
import type { Provider } from "../../types.ts";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir,{recursive:true,force:true})));
function fixture(text = "负责人李明，状态待处理", mismatchedTurn = false) {
  const dataDir = mkdtempSync(join(tmpdir(),"query-")); dirs.push(dataDir);
  const sources = [1,2].map(n => ({id:`turn_tn_0${n}`,content:{turnId:`tn_0${n}`,toolIO:[{callId:`call_0${n}`,turnId:mismatchedTurn ? "tn_99" : `tn_0${n}`,arguments:{reason:"核对"},return:{text}}],userInput:{id:`input_0${n}`,userInput:"保持状态"}}}));
  const entries: CompressionRecord[] = sources.map((source,n) => ({id:`sum_0${n+1}`,module:"conversationHistory",turnId:`tn_0${n+1}`,level:1,summary:"状态核对。",userRequest:"核对",actions:"读取",result:"确认",sourceIds:[source.id],createdAt:"2026-09-12"}));
  entries.push({...entries[0]!,id:"sum_03",sourceIds:["sum_01"],level:2});
  commitArchive(dataDir,"cv_test",{version:1,module:"conversationHistory",entries,activeIds:["sum_03","sum_02"],coveredSourceIds:sources.map(s=>s.id)},sources,entries);
  return {dataDir,conversationId:"cv_test",repoRoot:resolve(import.meta.dir,"../../.."),sumId:"sum_03",module:"toolIO" as const,intent:"保存后的状态"};
}
function provider(turnIds = ["tn_01"], observe?: (input:Parameters<Provider["complete"]>[0])=>void, recordKeys?: string[]):Provider {
  return {async complete(input){observe?.(input); return {finish:"tool_calls",content:"",toolCalls:[{id:"call_01",name:"submitMatches",arguments:{turnIds,...(recordKeys ? {recordKeys} : {})}}],attempts:1,parseOk:true,schemaOk:true,faultCode:null,missing:[]};}};
}
test("query limits candidates to requested summary and module, retains native identities",async()=>{
  const input=fixture();
  const result=await queryContext({...input,provider:provider(["tn_01"],request=>{
    const data=queryTurnsFromUserMessage(request.messages[1]!.content);
    expect(data.turns.map(v=>v.turnId)).toEqual(["tn_01"]);
    expect(JSON.stringify(data.turns)).not.toContain("input_01");
  })});
  expect(result.status).toBe("complete");expect(result.records[0]).toMatchObject({callId:"call_01",turnId:"tn_01",return:{text:"负责人李明，状态待处理"}});
  expect((await queryContext({...input,provider:provider(["tn_02"])})).status).toBe("error");
  expect((await queryContext({...input,module:"summaries",provider:provider()})).records.map(r=>r.sumId)).toEqual(["sum_03","sum_01"]);
});
test("record keys use the visible callId for exact record retrieval",async()=>{
  const input=fixture();
  const result=await queryContext({...input,provider:provider(["tn_01"],undefined,["call_01"])});
  expect(result.status).toBe("complete");
  expect(result.records).toHaveLength(1);
  expect(result.records[0]).toMatchObject({callId:"call_01",turnId:"tn_01"});
});
test("oversized records return in one shot for the unified inline gate",async()=>{
  const input=fixture('带有"转义\\字符'.repeat(1500)); let calls=0;
  const p=provider(["tn_01"],()=>calls++);
  const result=await queryContext({...input,provider:p});
  expect(calls).toBe(1);
  expect(result.status).toBe("complete");
  expect(result.records).toHaveLength(1);
  expect(String((result.records[0]!.return as { text?: unknown }).text)).toBe('带有"转义\\字符'.repeat(1500));
});
test("complete candidates use one request; failure, cancellation and unmatched result do not return evidence",async()=>{
  const input=fixture("x".repeat(50000));let calls=0;
  const p=provider(["tn_01"],request=>{
    const turns=queryTurnsFromUserMessage(request.messages[1]!.content).turns;
    expect(turns).toHaveLength(1);
    expect(turns[0]!.records).toHaveLength(1);
    expect(String((turns[0]!.records[0]!.return as { text?: unknown }).text)).toBe("x".repeat(50000));
    calls++;
    throw new Error("offline");
  });
  expect(await queryContext({...input,provider:p})).toMatchObject({status:"error",records:[]});expect(calls).toBe(1);
  expect(await queryContext({...input,provider:provider([])})).toMatchObject({status:"not_found",records:[]});
  let stop=false;
  expect(await queryContext({...input,provider:provider(["tn_01"],()=>{stop=true;}),isCancelled:()=>stop})).toMatchObject({status:"cancelled",records:[]});
});

test("query rejects source identity disagreement without rewriting archived evidence",async()=>{
  const result=await queryContext({...fixture("evidence",true),provider:provider([],()=>{throw new Error("must not call provider");})});
  expect(result).toMatchObject({status:"error",records:[]});
  expect(result.detail).toContain("turnId 与来源轮次不一致");
});

test("query result retains provider fault codes without partial evidence", async () => {
  const input = fixture("x".repeat(50000));
  let calls = 0;
  const valid = provider();
  const result = await queryContext({ ...input, provider: { async complete(request) {
    const response = await valid.complete(request);
    calls++;
    return { ...response, finish: "error", faultCode: "provider_key_invalid", toolCalls: [] };
  } } });
  expect(calls).toBe(1);
  expect(result).toMatchObject({ ok: false, status: "error", faultCode: "provider_key_invalid", records: [] });
  expect(await queryContext({ ...input, provider: valid, isCancelled: () => true }))
    .toMatchObject({ faultCode: "stopped", status: "cancelled", records: [] });
  expect(await queryContext({ ...input, sumId: "missing", provider: valid }))
    .toMatchObject({ faultCode: "query_failed", status: "error", records: [] });
});

function fileFixture() {
  const dataDir = mkdtempSync(join(tmpdir(),"query-file-")); dirs.push(dataDir);
  const sources = [
    { id: "turn_tn_01", content: { turnId: "tn_01",
      notes: [{ id: "ws_note_01", turnId: "tn_01", boundId: "b01", callId: "call_note_01", callIds: ["call_note_01"], target: { kind: "file", key: "/src/auth.ts" }, op: "local_fs_read", result: { ok: true }, content: "buffered auth evidence", files: ["src/auth.ts"] }],
      observations: [{ id: "page_01", type: "local_fs_read", result: "token" }],
      workspace: [{ id: "ws01", turnId: "tn_01", boundId: "b01", callId: "call_w1", callIds: ["call_01"], target: { kind: "file", key: "/src/auth.ts" }, op: "local_fs_read", result: "token 在此校验", files: ["src/auth.ts:120-180"] }],
      toolIO: [{ callId: "call_01", turnId: "tn_01", name: "local_fs_read", arguments: { reason: "读鉴权", items: [{ path: "src/auth.ts", startLine: 120 }] }, return: { text: "token" } }] } },
    { id: "turn_tn_02", content: { turnId: "tn_02",
      notes: [{ id: "ws_note_02", turnId: "tn_02", boundId: "b02", callId: "call_note_02", callIds: ["call_note_02"], target: { kind: "file", key: "/src/other.ts" }, op: "local_fs_read", result: { ok: true }, content: "buffered other evidence", files: ["src/other.ts"] }],
      observations: [{ id: "page_02", type: "local_fs_list", result: "ok" }],
      workspace: [{ id: "ws02", turnId: "tn_02", boundId: "b02", callId: "call_w2", callIds: ["call_02"], target: { kind: "tool", key: "tool:local_run" }, op: "local_run", result: "分页 cursor" }],
      toolIO: [{ callId: "call_02", turnId: "tn_02", name: "local_fs_list", arguments: { reason: "列目录", path: "src/list" }, return: { text: "ok" } }] } },
  ];
  const entries: CompressionRecord[] = sources.map((source, n) => ({ id: `sum_0${n + 1}`, module: "conversationHistory", turnId: `tn_0${n + 1}`, level: 1, summary: "状态核对。", userRequest: "核对", actions: "读取", result: "确认", sourceIds: [source.id], createdAt: "2026-09-12" }));
  entries.push({ ...entries[0]!, id: "sum_03", sourceIds: ["sum_01", "sum_02"], level: 2 });
  commitArchive(dataDir, "cv_test", { version: 1, module: "conversationHistory", entries, activeIds: ["sum_03", "sum_02", "sum_01"], coveredSourceIds: sources.map(s => s.id) }, sources, entries);
  return { dataDir, conversationId: "cv_test", repoRoot: resolve(import.meta.dir, "../../.."), sumId: "sum_03", intent: "鉴权结论" };
}

test("file narrows workspace candidates to the turn that names the file", async () => {
  const input = fileFixture();
  const result = await queryContext({ ...input, module: "workspace" as const, file: "auth.ts", provider: provider(["tn_01"], request => {
    const data = queryTurnsFromUserMessage(request.messages[1]!.content);
    expect(data.request).toMatchObject({ file: "auth.ts" });
    expect(data.turns.map(v => v.turnId)).toEqual(["tn_01"]);
  }) });
  expect(result.status).toBe("complete");
  expect(result).toMatchObject({ file: "auth.ts" });
  expect(result.records).toHaveLength(1);
  expect(result.records[0]).toMatchObject({ id: "ws01", files: ["src/auth.ts:120-180"] });
});

test("file narrows toolIO candidates by the call's file arguments", async () => {
  const input = fileFixture();
  const result = await queryContext({ ...input, module: "toolIO" as const, file: "src/auth.ts", provider: provider(["tn_01"], request => {
    const data = queryTurnsFromUserMessage(request.messages[1]!.content);
    expect(data.turns.map(v => v.turnId)).toEqual(["tn_01"]);
  }) });
  expect(result.status).toBe("complete");
  expect(result.records).toHaveLength(1);
  expect(result.records[0]).toMatchObject({ callId: "call_01" });
});

test("file with no match short-circuits without spending a model roundtrip", async () => {
  const input = fileFixture();
  const dead: Provider = { async complete() { throw new Error("must not call provider"); } };
  const miss = await queryContext({ ...input, module: "workspace" as const, file: "nope.ts", provider: dead });
  expect(miss).toMatchObject({ status: "not_found", records: [] });
  expect(miss.detail).toContain("nope.ts");
  const unsupported = await queryContext({ ...input, module: "observations" as const, file: "auth.ts", provider: dead });
  expect(unsupported).toMatchObject({ status: "not_found", records: [] });
  expect(unsupported.detail).toContain("不带文件归因");
});

test("blank file behaves like no filter", async () => {
  const input = fileFixture();
  const result = await queryContext({ ...input, module: "workspace" as const, file: "   ", provider: provider(["tn_01", "tn_02"], request => {
    const data = queryTurnsFromUserMessage(request.messages[1]!.content);
    expect(data.turns.map(v => v.turnId).sort()).toEqual(["tn_01", "tn_02"]);
    expect(data.request).not.toHaveProperty("file");
  }) });
  expect(result.status).toBe("complete");
});


test("archived notes are retrievable by file and remain isolated to the requested summary source", async () => {
  const input = fileFixture();
  const found = await queryContext({ ...input, module: "notes", file: "auth.ts", provider: provider(["tn_01"], request => {
    const data = queryTurnsFromUserMessage(request.messages[1]!.content);
    expect(data.request.module).toBe("notes");
    expect(data.turns.map(turn => turn.turnId)).toEqual(["tn_01"]);
    expect(data.turns[0]!.records).toHaveLength(1);
    expect(data.turns[0]!.records[0]).toMatchObject({ id: "ws_note_01", content: "buffered auth evidence" });
  }) });
  expect(found).toMatchObject({ status: "complete", records: [{ id: "ws_note_01", callId: "call_note_01", turnId: "tn_01" }] });
  const dead: Provider = { complete: async () => { throw new Error("must not call provider"); } };
  const outsideSource = await queryContext({ ...input, sumId: "sum_01", module: "notes", file: "other.ts", provider: dead });
  expect(outsideSource).toMatchObject({ status: "not_found", records: [] });
});
