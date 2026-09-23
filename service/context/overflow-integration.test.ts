import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleTurn } from "../runtime/loop.ts";
import { loadLedger, newConversation, saveLedger, saveTurn } from "../runtime/store.ts";
import { loadMemories } from "../memory/store.ts";
import type { CompletionResult, Provider, ToolCall, Turn } from "../types.ts";
import { inputRecord } from "../runtime/ids.ts";
import { loadIndex } from "../context-archive/store.ts";
import { validateUserData } from "./data-schema.ts";
import { compressionTurnsFromUserMessage } from "../agents/compression/protocol.ts";

const repoRoot = join(import.meta.dir, "../..");
const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: name, name, arguments: { reason: "容量回归测试", ...args } });
const response = (...toolCalls: ToolCall[]): CompletionResult => ({ finish: "tool_calls", content: "", attempts: 1, parseOk: true, schemaOk: true, missing: [], faultCode: null, toolCalls });
const finish = () => response(call("finishTurn", { text: "完成"}));
const xmlSlots = (user: string): Record<string, unknown> => {
  const values: Record<string, unknown> = {};
  const re = /<([A-Za-z][A-Za-z0-9]*)>\n[\s\S]*?\n\n内容：\n([\s\S]*?)\n<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(user))) {
    const name = m[1]!, body = m[2]!;
    values[name] = name === "skill" || name === "tools" ? body : JSON.parse(body);
  }
  return values;
};
const slot = (user: string, name: string): any => xmlSlots(user)[name.replace(/^#/, "")];
const references = (value: unknown): { path: string; chars: number; format: string }[] => {
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, any>;
  if (object.contextFile) return [object.contextFile];
  return Object.values(object).flatMap(references);
};
const provider = (run: (user: string) => CompletionResult): Provider => ({ complete: async ({ messages, tools }) => {
  if (tools.some(tool => tool.function.name === "submitTurnSummaries")) {
    const turns = compressionTurnsFromUserMessage(messages[1]!.content);
    return response({ id: "summary", name: "submitTurnSummaries", arguments: { tag: "容量测试", actions: "保存和读取文件", result: "成功" } });
  }
  expect(messages.reduce((size, message) => size + message.content.length, 0)).toBeLessThanOrEqual(250_000);
  const values = xmlSlots(messages[1]!.content);
  expect(validateUserData(values), JSON.stringify(validateUserData.errors)).toBe(true);
  return run(messages[1]!.content);
} });
const host = { execute: async () => ({ ok: true }) };
async function withDir(run: (dataDir: string) => Promise<void>) {
  const dataDir = mkdtempSync(join(tmpdir(), "context-overflow-integration-"));
  try { await run(dataDir); } finally { rmSync(dataDir, { recursive: true, force: true }); }
}

test("oversized notes stay durable, can be deleted by the model, and do not block the next turn", () => withDir(async dataDir => {
  const value = "N".repeat(305_000);
  const conversationId = newConversation(dataDir).conversationId!;
  let step = 0;
  const reply = await handleTurn({ dataDir, repoRoot, host, provider: provider(user => {
    if (++step === 1) return response(call("notes.write", { key: "large", value }));
    if (step === 2) {
      const refs = references(slot(user, "#notes"));
      expect(refs.length).toBeGreaterThan(0);
      expect(readFileSync(refs[0]!.path, "utf8")).toContain(value);
      const ledger = loadLedger(dataDir, conversationId);
      expect(ledger.notes.large).toBe(value);
      return response(call("notes.delete", { key: "large" }));
    }
    expect(slot(user, "#notes")).toMatchObject({ turnId: expect.stringMatching(/^tn_/), notes: {} });
    return finish();
  }) }, { userInput: "保存后删除大笔记", submittedAt: "now" });
  expect(reply.output).toEqual({ kind: "reply", text: "完成" });
  expect(step).toBe(3);
  expect(loadLedger(dataDir, reply.conversationId).notes).toEqual({});
  let nextCalls = 0;
  const next = await handleTurn({ dataDir, repoRoot, host, provider: provider(() => { nextCalls++; return finish(); }) }, { userInput: "继续", submittedAt: "later" });
  expect(next.output.kind).toBe("reply");
  expect(nextCalls).toBe(1);
}));

test("oversized project memory is referenced in a new conversation without losing its original text", () => withDir(async dataDir => {
  const text = "P".repeat(305_000);
  let step = 0;
  const original = await handleTurn({ dataDir, repoRoot, host, provider: provider(() => ++step === 1
    ? response(call("memory.write", { projectMemory: [text] })) : finish()) }, { userInput: "保存长期记忆", submittedAt: "now" });
  expect(original.output.kind).toBe("reply");
  const fresh = newConversation(dataDir).conversationId!;
  let calls = 0;
  const reply = await handleTurn({ dataDir, repoRoot, host, provider: provider(user => {
    calls++;
    const refs = references(slot(user, "#projectMemory"));
    expect(refs.length).toBeGreaterThan(0);
    expect(readFileSync(refs[0]!.path, "utf8")).toContain(text);
    return finish();
  }) }, { userInput: "读取长期记忆", submittedAt: "later" });
  expect(reply.conversationId).toBe(fresh);
  expect(reply.output.kind).toBe("reply");
  expect(calls).toBe(1);
  expect(loadMemories(dataDir, fresh, { conversation: [], project: [] }).project[0]!.text).toBe(text);
}));

test("large script results use evidence.search while small follow-up pages stay inline", () => withDir(async dataDir => {
  const code = "//PAGE_SENTINEL\n" + "x".repeat(305_000);
  mkdirSync(join(dataDir, "scripts"));
  writeFileSync(join(dataDir, "scripts", "large.js"), code);
  let step = 0;
  const reply = await handleTurn({ dataDir, repoRoot, host, provider: provider(user => {
    if (++step === 1) return response(call("catalog.add", { names: ["script_read", "evidence.search"] }));
    if (step === 2) return response(call("script_read", { filename: "large.js" }));
    if (step === 3) {
      const toolIO = slot(user, "#toolIO");
      const row = toolIO.find((item: any) => item.name === "script_read");
      expect(row).toBeDefined();
      const stub = JSON.parse(JSON.stringify(row.return.result));
      expect(stub.externalized).toBe(true);
      expect(String(stub.preview).length).toBeGreaterThan(0);
      expect(String(stub.path)).toContain("returns");
      return response(call("evidence.search", { windows: [{ callId: row.callId, keyword: "PAGE_SENTINEL", contextChars: 20 }] }));
    }
    const toolIO = slot(user, "#toolIO");
    const search = toolIO.find((row: any) => row.name === "evidence.search");
    expect(search).toBeDefined();
    const parsed = typeof search.return.result === "string" ? JSON.parse(search.return.result) : search.return.result;
    const hit = parsed.results[0];
    expect(parsed.ok).toBe(true);
    expect(hit.matches[0].hit).toBe("PAGE_SENTINEL");
    expect(String(hit.path)).toContain("returns");
    return finish();
  }) }, { userInput: "读取大脚本并检索关键标记", submittedAt: "now" });
  expect(reply.output.kind).toBe("reply");
  expect(step).toBe(4);
  expect(readFileSync(join(dataDir, "scripts", "large.js"), "utf8")).toBe(code);
}));

test("individually small notes are externalized when their combined context exceeds 250K", () => withDir(async dataDir => {
  const conversationId = newConversation(dataDir).conversationId!;
  const ledger = loadLedger(dataDir, conversationId);
  ledger.notes = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`note${index}`, String(index).repeat(70_000)]));
  saveLedger(dataDir, ledger);
  let calls = 0;
  const reply = await handleTurn({ dataDir, repoRoot, host, provider: provider(user => {
    calls++;
    expect(references(slot(user, "#notes")).length).toBeGreaterThan(0);
    return finish();
  }) }, { userInput: "继续使用这些笔记", submittedAt: "now" });
  expect(reply.output.kind).toBe("reply");
  expect(calls).toBe(1);
  expect(loadLedger(dataDir, conversationId).notes).toEqual(ledger.notes);
}));


test("context storage failure stops before sending a broken reference to the model", () => withDir(async dataDir => {
  const conversationId = newConversation(dataDir).conversationId!;
  const ledger = loadLedger(dataDir, conversationId);
  ledger.notes.large = "X".repeat(260_000);
  saveLedger(dataDir, ledger);
  writeFileSync(join(dataDir, "context-files"), "blocked directory");
  let calls = 0;
  const reply = await handleTurn({ dataDir, repoRoot, host, provider: provider(() => { calls++; return finish(); }) }, { userInput: "继续", submittedAt: "now" });
  expect(reply.output).toMatchObject({ kind: "error", faultCode: "context_storage_failed" });
  expect((reply.output as { detail?: string }).detail).toBeTruthy();
  expect(calls).toBe(0);
  expect(loadLedger(dataDir, conversationId).notes.large).toBe(ledger.notes.large);
}));


test("uncompressible notes between 200K and 250K remain inline and allow the main model to run", () => withDir(async dataDir => {
  const conversationId = newConversation(dataDir).conversationId!;
  const ledger = loadLedger(dataDir, conversationId);
  ledger.notes.draft = "N".repeat(210_000);
  saveLedger(dataDir, ledger);
  let calls = 0;
  const base = provider(user => {
    calls++;
    const notesView = slot(user, "#notes") as { turnId?: string; notes?: Record<string, string> };
    expect(notesView.turnId).toMatch(/^tn_/);
    expect(notesView.notes).toEqual(ledger.notes);
    expect(existsSync(join(dataDir, "context-files"))).toBe(false);
    return finish();
  });
  const reply = await handleTurn({ dataDir, repoRoot, host, provider: { complete: async input => {
    expect(input.tools.some(tool => tool.function.name === "submitTurnSummaries")).toBe(false);
    expect(input.messages.reduce((size, message) => size + message.content.length, 0)).toBeGreaterThan(200_000);
    return base.complete(input);
  } } }, { userInput: "继续", submittedAt: "now" });
  expect(reply.output.kind).toBe("reply");
  expect(calls).toBe(1);
  expect(loadLedger(dataDir, conversationId).notes).toEqual(ledger.notes);
}));

test("history above 250K is compressed before any content is externalized", () => withDir(async dataDir => {
  const conversationId = newConversation(dataDir).conversationId!;
  const ledger = loadLedger(dataDir, conversationId);
  const turns: Turn[] = Array.from({length: 9}, (_, i) => ({
    goalChanges: [], conversationId, turnId: `tn_${String(i + 1).padStart(2, "0")}`, status: "completed",
    createdAt: "2026-09-11", completedAt: "2026-09-11",
    input: {id: `input_${String(i + 1).padStart(2, "0")}`, text: "H".repeat(35000), submittedAt: "2026-09-11"},
    assembled: {baseToolsIds: [], toolIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], openTabs: { ok: true, windows: [] }, currentPage: null, pageObservedHistory: []},
    output: {kind: "reply", text: "已完成" },
  }));
  ledger.turnIds = turns.map(turn => turn.turnId);
  ledger.userInputHistory = turns.map(inputRecord);
  ledger.notes.draft = "应保留的笔记";
  turns.forEach(turn => saveTurn(dataDir, turn));
  saveLedger(dataDir, ledger);
  let summaries = 0, main = 0;
  const base = provider(user => {
    main++;
    expect(summaries).toBeGreaterThan(0);
    const notesView = slot(user, "#notes") as { turnId?: string; notes?: Record<string, string> };
    expect(notesView.turnId).toMatch(/^tn_/);
    expect(notesView.notes).toEqual(ledger.notes);
    expect(existsSync(join(dataDir, "context-files"))).toBe(false);
    return finish();
  });
  const reply = await handleTurn({ dataDir, repoRoot, host, provider: {complete: async input => {
    if (input.tools.some(tool => tool.function.name === "submitTurnSummaries")) {
      summaries++;
      expect(main).toBe(0);
      expect(existsSync(join(dataDir, "context-files"))).toBe(false);
    } else {
      expect(input.messages.reduce((size, message) => size + message.content.length, 0)).toBeLessThan(200_000);
    }
    return base.complete(input);
  }} }, { userInput: "继续", submittedAt: "now" });
  expect(reply.output.kind).toBe("reply");
  expect(main).toBe(1);
  expect(loadIndex(dataDir, conversationId, "conversationHistory").coveredSourceIds.length).toBeGreaterThan(0);
  expect(loadLedger(dataDir, conversationId).userInputHistory.length).toBeGreaterThanOrEqual(turns.length);
}));
