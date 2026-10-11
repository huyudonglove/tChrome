import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { requestLoopSummaries, requestLoopFold, compressionLoopsFromUserMessage } from "./protocol.ts";
import type { Provider } from "../../types.ts";
import type { SummaryFields } from "../../context-archive/types.ts";
import { loopSummaryView } from "../../context/projections/records.ts";
import { commitArchive, loadIndex } from "../../context-archive/store.ts";
import { loop, model, repoRoot } from "./test-fixtures.ts";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const setup = () => { const dataDir = mkdtempSync(`${tmpdir()}/loop-protocol-`); dirs.push(dataDir); return { dataDir, conversationId: "cv_test", repoRoot }; };
test("source loop IDs are filled by runtime and complete loop bodies reach compression", async () => {
 const loops = [loop("loop_01", "userInput"), loop("loop_02")];
 const result = await requestLoopSummaries({ ...setup(), loops, provider: model(request => expect(compressionLoopsFromUserMessage(request.messages[1]!.content)).toEqual(loops), 2) });
 expect(result).toHaveLength(2); expect(result.every(row => row.loopIds.join() === "loop_01,loop_02")).toBe(true);
 expect(result[0]!.userRequest).toBe("修复并验证");
});
test("one bad submission rejects all summaries in the response", async () => {
 const good = model(undefined, 2); let calls = 0;
 await expect(requestLoopSummaries({ ...setup(), loops: [loop("loop_01")], provider: { async complete(request) { calls++; const response = await good.complete(request); response.toolCalls[1]!.arguments = { userRequest: "bad" }; return response; } } })).rejects.toThrow();
 expect(calls).toBe(1);
});
test("fold rejects multiple submissions instead of silently ignoring later entries", async () => {
 await expect(requestLoopFold({ ...setup(), level: 2, loopIds: ["loop_01", "loop_02"], rows: [], provider: model(undefined, 2) })).rejects.toThrow();
});

test("folding distinct requests preserves the model's combined goals instead of a loop-count placeholder", async () => {
 const rows = [
  { loopIds: ["loop_01"], userRequest: "退役重复工具", state: "定义已删除", constraints: ["保留现有权限"], pending: ["验证接线"], decisions: [] },
  { loopIds: ["loop_02"], userRequest: "修复侧栏显示", state: "已定位原因", constraints: [], pending: ["修改渲染"], decisions: [] },
 ];
 const combined = { userRequest: "退役重复工具；修复侧栏显示", state: "工具定义已删除，侧栏原因已定位。",
  constraints: ["保留现有权限"], pending: ["验证接线", "修改渲染"], decisions: [] };
 const result = await requestLoopFold({ ...setup(), level: 2, loopIds: ["loop_01", "loop_02"], rows,
  provider: { async complete(request) {
   const payload = JSON.parse(request.messages[1]!.content.replace(/^<summaryFold>\n/, "").replace(/\n<\/summaryFold>$/, ""));
   expect(payload.summaries).toEqual(rows);
   const response = await model().complete(request);
   response.toolCalls[0]!.arguments = combined;
   return response;
  } } });
 expect(result).toEqual({ ...combined, loopIds: ["loop_01", "loop_02"] });
});

test("model-authored fields survive initial compression, storage, projection and successive folds", async () => {
 const input = setup();
 const userRequest = "归纳用户目标且完整保存重要上下文。".repeat(30);
 const fields: SummaryFields = { userRequest, state: "已读取配置并验证输入，部署尚未执行。",
  constraints: ["发布前必须完成验证", "保留用户文件"], pending: ["确认部署窗口", "执行部署"], decisions: ["使用统一配置以避免多处状态漂移"] };
 const source = loop("loop_01", "userInput");
 source.runtime[0]!.content = "原始要求与模型归纳的目标不同：" + userRequest;
 const sources = [source, loop("loop_02")];
 const loopIds = sources.map(row => row.id);
 const provider: Provider = { async complete(request) {
  const user = request.messages[1]!.content;
  if (user.startsWith("<summaryFold>")) {
   const payload = JSON.parse(user.replace(/^<summaryFold>\n/, "").replace(/\n<\/summaryFold>$/, ""));
   expect(payload.summaries).toHaveLength(1);
   expect(payload.summaries[0]).toMatchObject(fields);
  } else expect(compressionLoopsFromUserMessage(user)).toEqual(sources);
  const response = await model().complete(request);
  response.toolCalls[0]!.arguments = fields;
  return response;
 } };
 let row = (await requestLoopSummaries({ ...input, loops: sources, provider }))[0]!;
 expect(row.userRequest.length).toBeGreaterThan(200);
 expect(row).toEqual({ ...fields, loopIds });
 for (const level of [1, 2, 3]) {
  const record = { ...row, id: `sum_0${level}`, module: "conversationHistory" as const,
   level, sourceIds: loopIds, createdAt: "2026-10-11" };
  commitArchive(input.dataDir, input.conversationId, { version: 1, module: "conversationHistory",
   entries: [record], activeIds: [record.id], coveredSourceIds: loopIds }, [], [record]);
  const saved = loadIndex(input.dataDir, input.conversationId, "conversationHistory").entries[0]!;
  expect(saved).toMatchObject(fields);
  expect(loopSummaryView([saved])[0]).toMatchObject(fields);
  if (level < 3) {
   row = await requestLoopFold({ ...input, provider, level: level + 1, loopIds, rows: [saved] });
   expect(row).toEqual({ ...fields, loopIds });
  }
 }
});

test.each([
 { constraints: "限制" }, { pending: [" "] }, { decisions: [123] }, { state: " " }, { userRequest: "" },
])("malformed structured fields reject every submission atomically: %j", async invalid => {
 const input = setup();
 let calls = 0;
 await expect(requestLoopSummaries({ ...input, loops: [loop("loop_01")], provider: {
  async complete(request) {
   calls++;
   const response = await model(undefined, 2).complete(request);
   response.toolCalls[1]!.arguments = { ...response.toolCalls[1]!.arguments, ...invalid };
   return response;
  },
 } })).rejects.toThrow("Invalid compression submission");
 expect(calls).toBe(1);
});
