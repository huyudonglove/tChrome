import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { requestSummary } from "./protocol.ts";
import type { CompletionResult } from "../../types.ts";
const repoRoot=resolve(import.meta.dir,"../../..");
const valid:CompletionResult={finish:"tool_calls",content:"正文不作为结果",toolCalls:[{id:"result",name:"submitSummary",arguments:{tag:"修改限制",summary:"保持状态"}}],attempts:1,parseOk:true,schemaOk:true,faultCode:null,missing:[]};
test("compression assembles private tool and consumes its arguments only",async()=>{
 const result=await requestSummary({repoRoot,payload:{text:"原话"},provider:{complete:async input=>{
  expect(input.tools.map(tool=>tool.function.name)).toEqual(["submitSummary"]);
  expect(input.tools[0]!.function.parameters.additionalProperties).toBe(false);
  return valid;
 }}});
 expect(result).toEqual({tag:"修改限制",summary:"保持状态"});
});
test("compression rejects text JSON, wrong/multiple calls and invalid arguments",async()=>{
 for(const response of [
  {...valid,finish:"stop" as const,content:'{"tag":"test","summary":"text"}',toolCalls:[]},
  {...valid,toolCalls:[{...valid.toolCalls[0]!,name:"finishTurn"}]},
  {...valid,toolCalls:[...valid.toolCalls,...valid.toolCalls]},
  {...valid,toolCalls:[{id:"result",name:"submitSummary",arguments:{tag:" ",summary:"text"}}]},
  {...valid,toolCalls:[{id:"result",name:"submitSummary",arguments:{tag:"tag",summary:"text",extra:true}}]},
 ]) await expect(requestSummary({repoRoot,payload:{},provider:{complete:async()=>response}})).rejects.toThrow();
});
