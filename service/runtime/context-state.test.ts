import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyLedger } from "./store.ts";
import { contextState, compressContext } from "./context-state.ts";
import { loadIndex } from "../compression/store.ts";
import type { Turn, Provider } from "../types.ts";
const repoRoot = join(import.meta.dir, "../..");

test("compression retains latest inputs/pages/memories and two complete tool batches without pruning originals", async () => {
 const dataDir=mkdtempSync(join(tmpdir(),'context-retain-'));
 try {
  const ledger=emptyLedger('cv_test');
  ledger.userInputHistory=Array.from({length:5},(_,i)=>({id:`input_${i}`,turnId:`tn_${i}`,userInput:`要求${i}`,submittedAt:'2026-09-11'}));
  ledger.toolIO=Array.from({length:6},(_,i)=>({callId:`call_${i}`,turnId:'tn_06',batchId:`batch_${Math.floor(i/2)}`,name:'page.get_summary',arguments:{},return:{stage:'complete' as const,text:`结果${i}`,totalChars:3}}));
  const pages=Array.from({length:5},(_,i)=>({id:`page_${i}`,turnId:'tn_06',tab:1,url:'https://example.com',title:'例子',description:`页面${i}`,observedAt:'2026-09-11',callId:`call_${i}`,toolName:'page.get_summary'}));
  const turn:Turn={turnId:'tn_06',conversationId:ledger.conversationId,status:'inferring',createdAt:'',completedAt:null,input:{id:'current',text:'当前输入',submittedAt:''},assembled:{baseToolsIds:[],toolIds:[],conversationMemoryIds:[],projectMemoryIds:[],mcpIds:[],currentTab:null,currentPage:pages[4]!,pageObservedHistory:pages},output:null};
  const memories={project:[],conversation:Array.from({length:5},(_,i)=>({memoryId:`mm_${i}`,layer:'conversation' as const,text:`记忆${i}`,summary:'',compressed:false,createdAt:'2026-09-11',sourceCallId:`call_${i}`}))};
  const before=JSON.stringify({ledger,turn,memories});
  let requests=0;
  const provider:Provider={complete:async ({tools})=>{requests++;expect(tools).toEqual([]);return {finish:'stop',content:JSON.stringify({tag:'历史事项',summary:'较早的两项记录'}),toolCalls:[],attempts:1,parseOk:true,schemaOk:true,faultCode:null,missing:[]};}};
  await compressContext({dataDir,repoRoot,provider,ledger,turn,memories,isCancelled:()=>false});
  const view=contextState(dataDir,ledger,turn,memories);
  expect(view.ledger.userInputHistory).toEqual(ledger.userInputHistory.slice(-3));
  expect(view.turn.assembled.pageObservedHistory).toEqual(pages.slice(-3));
  expect(view.turn.assembled.currentPage).toEqual(pages[4]!);
  expect(view.memories.conversation).toEqual(memories.conversation.slice(-3));
  expect(view.ledger.toolIO).toEqual(ledger.toolIO.slice(-4));
  expect(JSON.stringify({ledger,turn,memories})).toBe(before);
  expect(loadIndex(dataDir,ledger.conversationId,'toolIO').coveredSourceIds).toHaveLength(2);
  await compressContext({dataDir,repoRoot,provider,ledger,turn,memories,isCancelled:()=>false});
  expect(requests).toBe(4);
 }finally {rmSync(dataDir,{recursive:true,force:true});}
});

for (const fail of [false,true]) test(`send boundary compresses before main LLM; failure=${fail} preserves originals`, async () => {
 const dataDir=mkdtempSync(join(tmpdir(),'context-boundary-'));
 try {
  const {ensureSession,saveLedger,loadLedger}=await import('./store.ts');
  const {handleTurn}=await import('./loop.ts');
  const session=ensureSession(dataDir);
  const ledger=loadLedger(dataDir,session.conversationId);
  ledger.userInputHistory=Array.from({length:5},(_,i)=>({id:`input_${i}`,turnId:`tn_old_${i}`,userInput:`第${i}项`+'完整原话'.repeat(12000),submittedAt:'2026-09-11'}));
  saveLedger(dataDir,ledger);
  let main=0,aux=0;
  const provider:Provider={complete:async ({tools,messages})=>{
   const base={attempts:1,parseOk:true,schemaOk:true,faultCode:null,missing:[],toolCalls:[]};
   if(!tools.length) {aux++;return {...base,finish:fail?'error':'stop',faultCode:fail?'test_error':null,content:JSON.stringify({tag:'此前要求',summary:'较早用户要求的摘要'})};}
   main++;
   expect(aux).toBeGreaterThan(0);
   expect(messages[1]!.content).toContain('较早用户要求的摘要');
   expect(messages[1]!.content).not.toContain('input_0');
   return {...base,finish:'tool_calls',content:'',toolCalls:[{id:'finish',name:'finishTurn',arguments:{reason:'完成',affectsPage:false,text:'完成'}}]};
  }};
  const result=await handleTurn({dataDir,repoRoot,provider},{userInput:'继续',submittedAt:'2026-09-11'});
  expect(result.output).toEqual(fail?{kind:'error',faultCode:'compression_failed'}:{kind:'reply',text:'完成'});
  expect(main).toBe(fail?0:1);
  expect(loadLedger(dataDir,session.conversationId).userInputHistory).toEqual(ledger.userInputHistory);
  expect(loadIndex(dataDir,session.conversationId,'userInputHistory').coveredSourceIds.length).toBe(fail?0:2);
 } finally {rmSync(dataDir,{recursive:true,force:true});}
});

test("stop during compression cannot commit coverage or overwrite paused session", async () => {
 const dataDir=mkdtempSync(join(tmpdir(),'context-stop-'));
 try {
  const {ensureSession,saveLedger,loadLedger,stopTurn}=await import('./store.ts');
  const {handleTurn}=await import('./loop.ts');
  const session=ensureSession(dataDir),ledger=loadLedger(dataDir,session.conversationId);
  ledger.userInputHistory=Array.from({length:5},(_,i)=>({id:`input_${i}`,turnId:`tn_old_${i}`,userInput:'完整原话'.repeat(12000),submittedAt:'2026-09-11'}));
  saveLedger(dataDir,ledger);
  let release!:()=>void, started!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
  const provider:Provider={complete:async ({tools})=>{expect(tools).toEqual([]);started();await pending;return {finish:'stop',content:JSON.stringify({tag:'旧要求',summary:'摘要'}),toolCalls:[],attempts:1,parseOk:true,schemaOk:true,faultCode:null,missing:[]};}};
  const running=handleTurn({dataDir,repoRoot,provider},{userInput:'继续',submittedAt:'2026-09-11'});
  await entered;
  stopTurn(dataDir);
  release();
  expect((await running).output).toEqual({kind:'error',faultCode:'stopped'});
  expect(loadLedger(dataDir,session.conversationId).status).toBe('paused');
  expect(loadIndex(dataDir,session.conversationId,'userInputHistory').coveredSourceIds).toEqual([]);
 } finally {rmSync(dataDir,{recursive:true,force:true});}
});
