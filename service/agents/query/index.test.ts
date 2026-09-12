import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { commitArchive } from "../../context-archive/store.ts";
import { queryContext } from "./index.ts";
import type { CompressionRecord } from "../../context-archive/types.ts";
import type { Provider } from "../../types.ts";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir,{recursive:true,force:true})));
function fixture(text = "负责人李明，状态待处理", mismatchedTurn = false) {
  const dataDir = mkdtempSync(join(tmpdir(),"query-")); dirs.push(dataDir);
  const sources = [1,2].map(n => ({id:`turn_tn_0${n}`,content:{turnId:`tn_0${n}`,toolIO:[{callId:`call_0${n}`,turnId:mismatchedTurn ? "tn_99" : `tn_0${n}`,arguments:{reason:"核对"},return:{text}}],userInput:{id:`input_0${n}`,userInput:"保持状态"}}}));
  const entries: CompressionRecord[] = sources.map((source,n) => ({id:`sum_0${n+1}`,module:"conversationHistory",turnId:`tn_0${n+1}`,level:1,tag:"状态",userRequest:"核对",actions:"读取",result:"确认",sourceIds:[source.id],createdAt:"2026-09-12"}));
  entries.push({...entries[0]!,id:"sum_03",sourceIds:["sum_01"],level:2});
  commitArchive(dataDir,"cv_test",{version:1,module:"conversationHistory",entries,activeIds:["sum_03","sum_02"],coveredSourceIds:sources.map(s=>s.id)},sources,entries);
  return {dataDir,conversationId:"cv_test",repoRoot:resolve(import.meta.dir,"../../.."),sumId:"sum_03",module:"toolIO" as const,intent:"保存后的状态"};
}
function provider(turnIds = ["tn_01"], observe?: (input:Parameters<Provider["complete"]>[0])=>void):Provider {
  return {async complete(input){observe?.(input); return {finish:"tool_calls",content:"",toolCalls:[{id:"call_01",name:"submitMatches",arguments:{turnIds}}],attempts:1,parseOk:true,schemaOk:true,faultCode:null,missing:[]};}};
}
test("query limits candidates to requested summary and module, retains native identities",async()=>{
  const input=fixture();
  const result=await queryContext({...input,provider:provider(["tn_01"],request=>{
    const data=JSON.parse(request.messages[1]!.content);
    expect(data.turns.map((v:any)=>v.turnId)).toEqual(["tn_01"]);
    expect(JSON.stringify(data.turns)).not.toContain("input_01");
  })});
  expect(result.status).toBe("complete");expect(result.records[0]).toMatchObject({callId:"call_01",turnId:"tn_01",return:{text:"负责人李明，状态待处理"}});
  expect((await queryContext({...input,provider:provider(["tn_02"])})).status).toBe("error");
  expect((await queryContext({...input,module:"summaries",provider:provider()})).records.map(r=>r.sumId)).toEqual(["sum_03","sum_01"]);
});
test("oversized record pages exact JSON without repeated model calls, cursor cannot cross request",async()=>{
  const input=fixture('带有"转义\\字符'.repeat(1500)); let calls=0;
  const p=provider(["tn_01"],()=>calls++); let result=await queryContext({...input,provider:p}); const initialCalls=calls; let raw="";
  while(true){
    expect(JSON.stringify(result.records).length).toBeLessThanOrEqual(2000);
    const part=result.records[0]!.fragment as {offset:number;text:string};expect(part.offset).toBe(raw.length);raw+=part.text;
    if(!result.nextCursor)break;
    expect((await queryContext({...input, intent:"不同意图",cursor:result.nextCursor,provider:p})).status).toBe("error");
    result=await queryContext({...input,cursor:result.nextCursor,provider:p});
  }
  expect(result.status).toBe("complete");expect(calls).toBeGreaterThan(0);
  expect(JSON.parse(raw).return.text).toBe('带有"转义\\字符'.repeat(1500));expect(calls).toBe(initialCalls);
});
test("all candidate batches must succeed; cancellation and unmatched result do not return evidence",async()=>{
  const input=fixture("x".repeat(50000));let calls=0;
  const p=provider(["tn_01"],request=>{const turns=JSON.parse(request.messages[1]!.content).turns;expect(JSON.stringify(turns).length).toBeLessThanOrEqual(24000);expect(turns).toHaveLength(1);expect(turns[0].records.length).toBeGreaterThan(1);if(++calls===2)throw new Error("offline");});
  expect(await queryContext({...input,provider:p})).toMatchObject({status:"error",records:[]});expect(calls).toBe(2);
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
    return ++calls === 2 ? { ...response, finish: "error", faultCode: "provider_key_invalid", toolCalls: [] } : response;
  } } });
  expect(calls).toBe(2);
  expect(result).toMatchObject({ ok: false, status: "error", faultCode: "provider_key_invalid", records: [] });
  expect(await queryContext({ ...input, provider: valid, isCancelled: () => true }))
    .toMatchObject({ faultCode: "stopped", status: "cancelled", records: [] });
  expect(await queryContext({ ...input, sumId: "missing", provider: valid }))
    .toMatchObject({ faultCode: "query_failed", status: "error", records: [] });
});
