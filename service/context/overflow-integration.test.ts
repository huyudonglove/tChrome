import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runtimeConfig } from "../config/runtime.ts";
import { handleTurn } from "../runtime/loop.ts";
import { loadLedger, loadSession, newConversation, primeActiveTask, saveLedger, saveTurn } from "../runtime/store.ts";
import { loadMemories } from "../memory/store.ts";
import type { CompletionResult, Provider, ToolCall, Turn } from "../types.ts";
import { inputRecord } from "../runtime/ids.ts";
import { loadIndex } from "../context-archive/store.ts";
import { validateUserData } from "./data-schema.ts";
import { compressionLoopsFromUserMessage } from "../agents/compression/protocol.ts";

const repoRoot = join(import.meta.dir, "../..");
const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: name, name, arguments: { reason: "容量回归测试", ...args } });
const response = (...toolCalls: ToolCall[]): CompletionResult => ({ finish: "tool_calls", content: "", attempts: 1, parseOk: true, schemaOk: true, missing: [], faultCode: null, toolCalls });
const finish = () => response(call("finishTurn", { text: "完成"}));
const xmlSlots = (user: string): Record<string, unknown> => {
  const values: Record<string, unknown> = {};
  const re = /<([A-Za-z][A-Za-z0-9]*)(?:\s[^>]*)?>\n([\s\S]*?)\n<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(user))) {
    const name = m[1]!, body = m[2]!;
    values[name] = name === "skill" || name === "tools" || name === "conversation" || name === "projectMemory" || name === "contextUsage" ? body : JSON.parse(body);
  }
  return values;
};
const callRows = (xml: string): any[] => [...xml.matchAll(/<runtime[^>]*type="callsResult"[^>]*>\n([\s\S]*?)\n<\/runtime>/g)]
  .flatMap(match => JSON.parse(match[1]!)).map(row => ({ ...row, ok: row.result?.ok, return: row.result }));
const storedReturn = (dataDir: string, callId: string): any => JSON.parse(loadLedger(dataDir, loadSession(dataDir)!.conversationId!).toolIO.find(row => row.callId === callId)!.return.text);
const slot = (user: string, name: string): any => ["calls", "#toolIO"].includes(name) ? callRows(user) : [];
const provider = (run: (user: string) => CompletionResult): Provider => ({ complete: async ({ messages, tools }) => {
  if (tools.some(tool => tool.function.name === "submitLoopSummaries")) {
    const turns = compressionLoopsFromUserMessage(messages[1]!.content);
    return response({ id: "summary", name: "submitLoopSummaries", arguments: { summary: "容量测试保存和读取文件成功。", actions: "保存和读取文件", result: "成功" } });
  }
  expect(messages.reduce((size, message) => size + message.content.length, 0)).toBeLessThanOrEqual(runtimeConfig.context.hardLimitChars);
  const values = xmlSlots(messages[1]!.content);
  expect(validateUserData(values), JSON.stringify(validateUserData.errors)).toBe(true);
  return run(messages[1]!.content);
} });
const host = { execute: async () => ({ ok: true }) };
async function withDir(run: (dataDir: string) => Promise<void>) {
  const dataDir = mkdtempSync(join(tmpdir(), "context-overflow-integration-"));
    primeActiveTask(dataDir);
  try { await run(dataDir); } finally { rmSync(dataDir, { recursive: true, force: true }); }
}

test("repeated failed memory writes retain failure and separate runtime hints", () => withDir(async dataDir => {
  let step = 0;
  const reply = await handleTurn({ dataDir, repoRoot, provider: provider(user => {
    if (++step === 1) return response(call("catalog_add", { names: ["memory_update"] }));
    if (step <= 3) return response(call("memory_update", { memoryId: "mm_99", text: "updated" }));
    const row = slot(user, "calls").find((item: any) => item.name === "memory_update");
    expect(row.ok).toBe(false);
    expect(row.return.ok).toBe(false);
    expect(row.return.faultCode).toBeDefined();
    expect(row.runtimeHints[0]).toContain("runtime[repeat:call]");
    return finish();
  }) }, { userInput: "更新不存在的记忆以验证错误记录", submittedAt: "now" });
  const rows = loadLedger(dataDir, reply.conversationId).toolIO.filter(row => row.name === "memory_update");
  expect(rows).toHaveLength(2);
  expect(JSON.parse(rows[1]!.return.text).ok).toBe(false);
  expect(rows[1]!.runtimeHints).toHaveLength(1);
}));

test("image processing errors reach the model without changing the tool result", () => withDir(async dataDir => {
  let step = 0;
  const raw = { ok: true, image: "data:image/png;base64,AAAA" };
  const reply = await handleTurn({ dataDir, repoRoot, host: { execute: async () => raw }, provider: provider(user => {
    if (++step === 1) return response(call("catalog_add", { names: ["capture_page"] }));
    if (step === 2) return response(call("capture_page", { tabId: 1, mode: "viewport" }));
    const row = slot(user, "calls").find((item: any) => item.name === "capture_page");
    expect(row.ok).toBe(true);
    expect(row.return).toEqual(raw);
    expect(row.imagesError).toContain("invalid PNG signature");
    return finish();
  }) }, { userInput: "截图并报告图片处理异常", submittedAt: "now" });
  const saved = loadLedger(dataDir, reply.conversationId).toolIO.find(row => row.name === "capture_page")!;
  expect(JSON.parse(saved.return.text)).toEqual(raw);
  expect(saved.imagesError).toContain("invalid PNG signature");
  expect(saved.images).toBeUndefined();
}));

test("mixed file read failures stay visible after externalization and originals stay intact", () => withDir(async dataDir => {
  const path = join(dataDir, "large.ts");
  const missing = join(dataDir, "missing.ts");
  const content = "// source\n".repeat(runtimeConfig.results.inlineChars);
  writeFileSync(path, content);
  let step = 0;
  let sourceCallId = "";
  const reply = await handleTurn({ dataDir, repoRoot, provider: provider(user => {
    if (++step === 1) return response(call("catalog_add", { names: ["local_fs_read"] }));
    if (step === 2) return response(call("local_fs_read", { keepInCalls: true, items: [{ path }, { path: missing }] }));
    const row = slot(user, "calls").find((item: any) => item.name === "local_fs_read");
    sourceCallId = row.callId;
    expect(row.ok).toBe(false);
    expect(row.return).toMatchObject({ externalized: true, ok: false });
    expect(callRows(user).filter(item => item.callId === sourceCallId)).toHaveLength(1);
    expect(user.split(JSON.stringify(row.return.path))).toHaveLength(2);
    expect(user).not.toContain(content);
    const stub = storedReturn(dataDir, sourceCallId);
    expect(stub).toMatchObject({ ok: false, externalized: true });
    const original = JSON.parse(readFileSync(stub.path, "utf8"));
    expect(original.results[0].content).toBe(content);
    expect(original.results[1].faultCode).toBe("file_not_found");
    return finish();
  }) }, { userInput: "读取文件并报告失败项", submittedAt: "now" });
  expect(reply.stopReason, JSON.stringify(reply.stopReason)).toMatchObject({ kind: "reply" });
  const saved = loadLedger(dataDir, reply.conversationId).toolIO.find(row => row.callId === sourceCallId)!;
  expect(JSON.parse(saved.return.text).ok).toBe(false);
}));

test("large script results use evidence_search while small follow-up pages stay inline", () => withDir(async dataDir => {
  const code = "//PAGE_SENTINEL\n" + "x".repeat(305_000);
  mkdirSync(join(dataDir, "scripts"));
  writeFileSync(join(dataDir, "scripts", "large.js"), code);
  let step = 0;
  const reply = await handleTurn({ dataDir, repoRoot, host, provider: provider(user => {
    if (++step === 1) return response(call("catalog_add", { names: ["script_read", "evidence_search"] }));
    if (step === 2) return response(call("script_read", { keepInCalls: true, filename: "large.js" }));
    if (step === 3) {
      const toolIO = slot(user, "#toolIO");
      const row = toolIO.find((item: any) => item.name === "script_read");
      expect(row).toBeDefined();
      expect(row.return).toMatchObject({ externalized: true });
      expect(row.return).not.toHaveProperty("code");
      expect(user).not.toContain(code);
      const stub = storedReturn(dataDir, row.callId);
      expect(stub.externalized).toBe(true);
      expect(stub.directory.kind).toBe("directory");
      expect(stub.directory.children.length).toBeGreaterThan(0);
      expect(String(stub.path)).toContain("returns");
      expect(JSON.parse(readFileSync(stub.path, "utf8")).code).toBe(code);
      return response(call("evidence_search", { keepInCalls: true, windows: [{ callId: row.callId, keyword: "PAGE_SENTINEL" }] }));
    }
    const toolIO = slot(user, "#toolIO");
    const search = toolIO.find((row: any) => row.name === "evidence_search");
    expect(search).toBeDefined();
    const hit = search.return.results[0];
    expect(search.ok).toBe(true);
    expect(hit.kind).toBe("search");
    expect(hit.matches[0].snippet).toContain("PAGE_SENTINEL");
    expect(hit.matches[0].blockId).toBeDefined();
    expect(String(hit.path)).toContain("returns");
    return finish();
  }) }, { userInput: "读取大脚本并检索关键标记", submittedAt: "now" });
  expect(reply.stopReason, JSON.stringify(reply.stopReason)).toMatchObject({ kind: "reply" });
  expect(step).toBe(4);
  expect(readFileSync(join(dataDir, "scripts", "large.js"), "utf8")).toBe(code);
}));





test("history above the compress threshold is compressed before the main model runs", () => withDir(async dataDir => {
  const conversationId = newConversation(dataDir).conversationId!;
    primeActiveTask(dataDir);
  const ledger = loadLedger(dataDir, conversationId);
  const turns: Turn[] = Array.from({length: 9}, (_, i) => ({
    conversationId, turnId: `tn_${String(i + 1).padStart(2, "0")}`, status: "completed",
    createdAt: "2026-09-11", completedAt: "2026-09-11",
    input: {id: `input_${String(i + 1).padStart(2, "0")}`, text: "H".repeat(35000), submittedAt: "2026-09-11"},
    assembled: {baseToolsIds: [], toolIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], currentTabs: { ok: true, windows: [] }, currentPage: null, observations: []},
    stopReason: { kind: "reply", text: "已完成" },
  }));
  ledger.turnIds = turns.map(turn => turn.turnId);
  ledger.userInputHistory = turns.map(inputRecord);
  turns.forEach(turn => saveTurn(dataDir, turn));
  ledger.loops = turns.map((turn, index) => ({ id: `loop_${index + 1}`, conversationId, turnId: turn.turnId, createdAt: turn.createdAt, completedAt: turn.completedAt!, runtime: [{ id: `rt_${index + 1}`, type: "userInput", content: turn.input.text }], helm: { id: `helm_${index + 1}`, content: "已完成", calls: [], finish: "stop" } }));
  saveLedger(dataDir, ledger);
  let summaries = 0, main = 0;
  const base = provider(user => {
    main++;
    expect(summaries).toBeGreaterThan(0);
    expect(user).toContain("<summaries>");
    return finish();
  });
  const reply = await handleTurn({ dataDir, repoRoot, host, provider: {complete: async input => {
    if (input.tools.some(tool => tool.function.name === "submitLoopSummaries")) {
      summaries++;
      expect(main).toBe(0);
    } else {
      expect(input.messages.reduce((size, message) => size + message.content.length, 0)).toBeLessThan(runtimeConfig.context.compressAtChars);
    }
    return base.complete(input);
  }} }, { userInput: "继续", submittedAt: "now" });
  expect(reply.stopReason, JSON.stringify(reply.stopReason)).toMatchObject({ kind: "reply" });
  expect(main).toBe(1);
  expect(loadIndex(dataDir, conversationId, "conversationHistory").coveredSourceIds.length).toBeGreaterThan(0);
  expect(loadLedger(dataDir, conversationId).userInputHistory.length).toBeGreaterThanOrEqual(turns.length);
}));
