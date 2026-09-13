import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyLedger, saveTurn } from "./store.ts";
import { assembleTurnHistory, loadSettledTurnHistory } from "./turn-history.ts";
import type { Turn } from "../types.ts";
const turn = (turnId:string):Turn => ({goalChanges:[],conversationId:"cv_test",turnId,status:"completed",createdAt:"2026-09-11",completedAt:"2026-09-11",input:{id:`input_${turnId}`,text:"只改负责人",submittedAt:"2026-09-11"},assembled:{baseToolsIds:[],toolIds:[],conversationMemoryIds:[],projectMemoryIds:[],mcpIds:[],currentTab:null,currentPage:null,pageObservedHistory:[]},output:{kind:"reply",text:"已修改并核对"}});
test("turn process joins existing records without mixing turns or mutable memory/notes",()=>{
 const ledger=emptyLedger("cv_test");ledger.turnIds=["tn_01","tn_02"];
 ledger.notes={draft:"当前草稿"};
 const first=turn("tn_01");
 first.goalChanges=[{parentId:null,status:"active",updatedAt:"2026-09-11",id:"g1",turnId:"tn_01",goal:"修改负责人",sourceCallId:"c1",createdAt:"2026-09-11"}];
 ledger.goals=[{parentId:null,status:"completed",updatedAt:"2026-09-12",id:"g1",turnId:"tn_02",goal:"另一目标",sourceCallId:"c2",createdAt:"2026-09-11"}];
 ledger.toolIO=["tn_01","tn_02"].map((turnId,i)=>({turnId,callId:`c${i}`,name:"page.get_summary",arguments:{},return:{stage:"complete",text:"完整结果",totalChars:4}}));
 first.assembled.pageObservedHistory=[{id:"p1",turnId:"tn_01",tab:1,url:"https://example.com",title:"任务",description:"已修改",observedAt:"2026-09-11",callId:"c0",toolName:"page.get_summary"}];
 const snapshot=JSON.stringify({ledger,first}), record=assembleTurnHistory(ledger,first);
 expect(record.toolIO).toHaveLength(1);expect(record.goalChanges).toEqual(first.goalChanges);
 expect(record.goalChanges[0]!.goal).toBe("修改负责人");
 expect(record.goalChanges[0]!.status).toBe("active");
 expect(record.pageObservations).toEqual(first.assembled.pageObservedHistory);
 expect(record.userInput.id).toBe(first.input.id);expect(record.output).toEqual(first.output);
 expect(record).not.toHaveProperty("notes");expect(record).not.toHaveProperty("memory");
 record.toolIO[0]!.return.text="修改投影";
 expect(JSON.stringify({ledger,first})).toBe(snapshot);
 expect(()=>assembleTurnHistory({...ledger,conversationId:"cv_other"},first)).toThrow();
});
test("settled history preserves order and error outputs, excluding active and unfinished turns",()=>{
 const dir=mkdtempSync(join(tmpdir(),"turn-history-"));
 try {
  const ledger=emptyLedger("cv_test");ledger.turnIds=["tn_01","tn_02","tn_03"];
  const failed=turn("tn_02");failed.status="failed";failed.output={kind:"error",faultCode:"provider_error"};
  const current=turn("tn_03");current.status="inferring";current.completedAt=null;current.output=null;
  for(const row of [turn("tn_01"),failed,current])saveTurn(dir,row);
  ledger.active={turnId:"tn_03"};
  const records=loadSettledTurnHistory(dir,ledger);
  expect(records.map(row=>row.turnId)).toEqual(["tn_01","tn_02"]);
  expect(records[1]!.output).toEqual(failed.output);
 }finally {rmSync(dir,{recursive:true,force:true});}
});
