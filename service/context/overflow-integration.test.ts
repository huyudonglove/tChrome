import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runtimeConfig } from "../config/runtime.ts";
import { handleTurn } from "../runtime/loop.ts";
import { loadLedger, newConversation, primeActiveTask, saveLedger, saveTurn } from "../runtime/store.ts";
import { loadMemories } from "../memory/store.ts";
import type { CompletionResult, Provider, ToolCall, Turn } from "../types.ts";
import { inputRecord } from "../runtime/ids.ts";
import { loadIndex } from "../context-archive/store.ts";
import { validateUserData } from "./data-schema.ts";
import { stripWorkspaceSuggestion } from "../runtime/workspace.ts";
import { compressionTurnsFromUserMessage } from "../agents/compression/protocol.ts";

const repoRoot = join(import.meta.dir, "../..");
const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: name, name, arguments: { reason: "容量回归测试", ...args } });
const response = (...toolCalls: ToolCall[]): CompletionResult => ({ finish: "tool_calls", content: "", attempts: 1, parseOk: true, schemaOk: true, missing: [], faultCode: null, toolCalls });
const finish = () => response(call("finishTurn", { text: "完成"}));
const xmlSlots = (user: string): Record<string, unknown> => {
  const values: Record<string, unknown> = {};
  const re = /<([A-Za-z][A-Za-z0-9]*)(?:\s[^>]*)?>\n能力：[\s\S]*?\n\n内容：\n([\s\S]*?)\n<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(user))) {
    const name = m[1]!, body = m[2]!;
    values[name] = name === "skill" || name === "tools" || name === "conversation" ? body : JSON.parse(body);
  }
  return values;
};
const nestedTag = (user: string, name: string): any => {
  const conversation = String(xmlSlots(user).conversation ?? "");
  const m = conversation.match(new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`));
  return m ? JSON.parse(m[1]!) : undefined;
};
// <toolIO> 池渲染成 <call ...> 兄弟元素：元数据在属性、result 在正文 JSON。
const callRows = (xml: string): any[] => {
  const rows: any[] = [];
  const re = /<call\s+([^>]*)>\n([\s\S]*?)\n<\/call>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs: Record<string, string> = {};
    for (const am of m[1]!.matchAll(/([A-Za-z][A-Za-z0-9]*)=\"([^\"]*)\"/g)) attrs[am[1]!] = am[2]!;
    let payload: any;
    try { payload = JSON.parse(m[2]!); } catch { payload = { body: m[2]! }; }
    const { ok, ...rest } = attrs;
    rows.push({ ...rest, ok: ok === "true", ...payload });
  }
  return rows;
};
// <notes> renders one <note key="…"> per entry: rebuild the map for slot assertions.
const noteRows = (xml: string): Record<string, string> => {
  const rows: Record<string, string> = {};
  const re = /<note\s+([^>]*)>\n([\s\S]*?)\n<\/note>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) rows[/key="([^"]*)"/.exec(m[1]!)?.[1] ?? ""] = m[2]!;
  return rows;
};
const slot = (user: string, name: string): any => {
  const key = name.replace(/^#/, "");
  const conversation = String(xmlSlots(user).conversation ?? "");
  // toolIO is a shared pool at the bottom of <conversation>, not inside a turn slice.
  if (key === "toolIO") {
    const pool = conversation.match(/<toolIO(?:\s[^>]*)?>\n([\s\S]*?)\n<\/toolIO>/);
    return pool ? callRows(pool[1]!) : [];
  }
  if (key === "notes") {
    const notes = conversation.match(/<notes(?:\s[^>]*)?>\n([\s\S]*?)\n<\/notes>/);
    return notes ? noteRows(notes[1]!) : {};
  }
  if (key === "userInput" || key === "goal" || key === "task") {
    const turn = conversation.match(/<turn[^>]*>\n([\s\S]*?)\n<\/turn>/);
    const body = turn?.[1] ?? conversation;
    const m = body.match(new RegExp(`<${key}(?:\\s[^>]*)?>\\n([\\s\\S]*?)\\n</${key}>`));
    if (!m) return [];
    try { return JSON.parse(m[1]!); } catch { return m[1]!; }
  }
  return xmlSlots(user)[key];
};
const provider = (run: (user: string) => CompletionResult): Provider => ({ complete: async ({ messages, tools }) => {
  if (tools.some(tool => tool.function.name === "submitTurnSummaries")) {
    const turns = compressionTurnsFromUserMessage(messages[1]!.content);
    return response({ id: "summary", name: "submitTurnSummaries", arguments: { tag: "容量测试", actions: "保存和读取文件", result: "成功" } });
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

test("large script results use evidence_search while small follow-up pages stay inline", () => withDir(async dataDir => {
  const code = "//PAGE_SENTINEL\n" + "x".repeat(305_000);
  mkdirSync(join(dataDir, "scripts"));
  writeFileSync(join(dataDir, "scripts", "large.js"), code);
  let step = 0;
  const reply = await handleTurn({ dataDir, repoRoot, host, provider: provider(user => {
    if (++step === 1) return response(call("catalog_add", { names: ["script_read", "evidence_search"] }));
    if (step === 2) return response(call("script_read", { filename: "large.js" }));
    if (step === 3) {
      const toolIO = slot(user, "#toolIO");
      const row = toolIO.find((item: any) => item.name === "script_read");
      expect(row).toBeDefined();
      // 窗口投影里返回末尾可能挂工作区建议，先裁再解析。
      const rawReturn = typeof row.return === "string" ? row.return : JSON.stringify(row.return);
      const stub = JSON.parse(stripWorkspaceSuggestion(rawReturn));
      expect(stub.externalized).toBe(true);
      expect(String(stub.head ?? stub.summary).length).toBeGreaterThan(0);
      expect(String(stub.path)).toContain("returns");
      return response(call("evidence_search", { windows: [{ callId: row.callId, keyword: "PAGE_SENTINEL", contextChars: 20 }] }));
    }
    const toolIO = slot(user, "#toolIO");
    const search = toolIO.find((row: any) => row.name === "evidence_search");
    expect(search).toBeDefined();
    const searchRaw = typeof search.return === "string" ? search.return : JSON.stringify(search.return);
    const parsed = JSON.parse(stripWorkspaceSuggestion(searchRaw));
    const hit = parsed.results[0];
    expect(parsed.ok).toBe(true);
    expect(hit.matches[0].hit).toBe("PAGE_SENTINEL");
    expect(String(hit.path)).toContain("returns");
    return finish();
  }) }, { userInput: "读取大脚本并检索关键标记", submittedAt: "now" });
  expect(reply.stopReason.kind).toBe("reply");
  expect(step).toBe(4);
  expect(readFileSync(join(dataDir, "scripts", "large.js"), "utf8")).toBe(code);
}));





test("notes above the hard limit fail the turn with context_limit instead of being externalized", () => withDir(async dataDir => {
  const conversationId = newConversation(dataDir).conversationId!;
    primeActiveTask(dataDir);
  const ledger = loadLedger(dataDir, conversationId);
  ledger.notes.draft = "N".repeat(Math.round(runtimeConfig.context.hardLimitChars * 1.1));
  saveLedger(dataDir, ledger);
  let calls = 0;
  const reply = await handleTurn({ dataDir, repoRoot, host, provider: { complete: async () => { calls++; return finish(); } } }, { userInput: "继续", submittedAt: "now" });
  expect(reply.stopReason).toMatchObject({ kind: "error", faultCode: "context_limit" });
  expect(calls).toBe(0);
  expect(existsSync(join(dataDir, "context-files"))).toBe(false);
  expect(loadLedger(dataDir, conversationId).notes).toEqual(ledger.notes);
}));

test("history above the compress threshold is compressed before the main model runs", () => withDir(async dataDir => {
  const conversationId = newConversation(dataDir).conversationId!;
    primeActiveTask(dataDir);
  const ledger = loadLedger(dataDir, conversationId);
  const turns: Turn[] = Array.from({length: 9}, (_, i) => ({
    conversationId, turnId: `tn_${String(i + 1).padStart(2, "0")}`, status: "completed",
    createdAt: "2026-09-11", completedAt: "2026-09-11",
    input: {id: `input_${String(i + 1).padStart(2, "0")}`, text: "H".repeat(35000), submittedAt: "2026-09-11"},
    assembled: {baseToolsIds: [], toolIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], currentTabs: { ok: true, windows: [] }, currentPage: null, observations: [], workspace: []},
    stopReason: { kind: "reply", text: "已完成" },
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
    const notesView = slot(user, "#notes") as Record<string, string>;
    expect(notesView).toEqual(ledger.notes);
    return finish();
  });
  const reply = await handleTurn({ dataDir, repoRoot, host, provider: {complete: async input => {
    if (input.tools.some(tool => tool.function.name === "submitTurnSummaries")) {
      summaries++;
      expect(main).toBe(0);
    } else {
      expect(input.messages.reduce((size, message) => size + message.content.length, 0)).toBeLessThan(runtimeConfig.context.compressAtChars);
    }
    return base.complete(input);
  }} }, { userInput: "继续", submittedAt: "now" });
  expect(reply.stopReason.kind).toBe("reply");
  expect(main).toBe(1);
  expect(loadIndex(dataDir, conversationId, "conversationHistory").coveredSourceIds.length).toBeGreaterThan(0);
  expect(loadLedger(dataDir, conversationId).userInputHistory.length).toBeGreaterThanOrEqual(turns.length);
}));
