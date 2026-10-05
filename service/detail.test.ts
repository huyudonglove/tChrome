import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeConfig } from "./config/runtime.ts";
import { handleTurn } from "./runtime/loop.ts";
import { ensureSession, loadLedger, saveLedger, saveTurn, stopTurn, sessionView } from "./runtime/store.ts";
import { allocateRecordId, inputRecord, pacificDate } from "./runtime/ids.ts";
import { archiveDir, commitArchive, loadIndex } from "./context-archive/store.ts";
import { loadContextModules } from "./context/modules.ts";
import { validateUserData } from "./context/data-schema.ts";
import { systemText, userText } from "./context/window.ts";
import { loadToolRegistry, coreToolIds, toolGuideFor } from "./tools/registry.ts";
import { skillGuide, loadSkills } from "./skills/loader.ts";
import { contextState } from "./runtime/context-state.ts";
import { compressionTurnsFromUserMessage } from "./agents/compression/protocol.ts";
import type { CompletionResult, Provider, Turn } from "./types.ts";
const repoRoot = join(import.meta.dir, "..");
const reply = (toolCalls: CompletionResult["toolCalls"]): CompletionResult => ({ content: "", finish: "tool_calls", toolCalls, attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [] });
const finish = () => reply([{ id: "finish", name: "finishTurn", arguments: { reason: "已核对", text: "完成"} }]);
const section = (user: string, tag: string) => {
  const m = user.match(new RegExp(`<${tag}>\\n[\\s\\S]*?\\n\\n内容：\\n([\\s\\S]*?)\\n</${tag}>`));
  if (m) return JSON.parse(m[1]!);
  const all = collectNested(user, tag === "toolIO" ? "call" : tag);
  if (tag === "toolIO" || tag === "query") return all;
  return all.length ? all.at(-1) : tag === "notes" ? {} : null;
};
const collectNested = (user: string, tag: string): any[] => {
  const rows: any[] = [];
  // Record elements carry their scalar fields (id/externalized/...) as attributes, and
  // a body is raw JSON, a "内容：" block, or an externalization notice. Scan open tags by hand and pair
  // each with its own closing tag: a lazy regex can swallow the following record and lose attributes.
  const open = new RegExp(`<${tag}(\\s[^>]*?)?>`, "g");
  for (let m = open.exec(user); m; m = open.exec(user)) {
    const attrs = attrRecord(m[1] ?? "");
    // Rendered descriptions mention bare tag names (e.g. "<query>：本轮查询"); skip those.
    if (!Object.keys(attrs).length) continue;
    const bodyStart = open.lastIndex;
    const close = user.indexOf(`</${tag}>`, bodyStart);
    const raw = close === -1 ? user.slice(bodyStart) : user.slice(bodyStart, close);
    const marker = raw.indexOf("内容：");
    const body = marker === -1 ? raw : raw.slice(marker + 4);
    let parsed: any;
    try { parsed = JSON.parse(body.trim()); } catch { rows.push({ ...attrs, __unparsed: body.trim() }); continue; }
    for (const row of Array.isArray(parsed) ? parsed : [parsed]) rows.push({ ...attrs, ...row });
  }
  return rows;
};
// Record elements carry their scalar fields (name/stage/ok/externalized/...) as
// attributes, so a body-only parse loses exactly the fields the assertions read.
const attrRecord = (raw: string): Record<string, any> => {
  const attrs: Record<string, any> = {};
  for (const m of raw.matchAll(/([A-Za-z_][\w-]*)="([^"]*)"/g)) {
    attrs[m[1]!] = m[2] === "true" ? true : m[2] === "false" ? false : m[2];
  }
  return attrs;
};
function fixture(dataDir: string, text = "精确证据".repeat(250)) {
  const { conversationId: cv } = ensureSession(dataDir), ledger = loadLedger(dataDir, cv);
  const turns = Array.from({ length: 6 }, (_, i): Turn => ({ conversationId: cv, turnId: allocateRecordId(dataDir, cv, "turn"), status: "completed", createdAt: "2026-09-12", completedAt: "2026-09-12", input: { id: allocateRecordId(dataDir, cv, "input"), text: `要求${i}`, submittedAt: "2026-09-12" }, assembled: { baseToolsIds: [], toolIds: [], conversationMemoryIds: [], projectMemoryIds: [], mcpIds: [], currentTabs: { ok: true, windows: [] }, currentPage: null, observations: [], workspace: [] }, stopReason: { kind: "reply", text: "完成" } }));
  ledger.turnIds = turns.map(row => row.turnId); ledger.userInputHistory = turns.slice(0, -1).map(inputRecord);
  turns.forEach(turn => saveTurn(dataDir, turn));
  const tool = { callId: allocateRecordId(dataDir, cv, "call"), turnId: "tn_01", batchId: allocateRecordId(dataDir, cv, "batch"), name: "page_get_summary", arguments: {}, return: { stage: "complete", totalChars: text.length, text } };
  const sumId = allocateRecordId(dataDir, cv, "sum");
  const sourceId = allocateRecordId(dataDir, cv, "source");
  const summary = { id: sumId, module: "conversationHistory" as const, level: 1, turnId: "tn_01", summary: "详情读取完成。", userRequest: "读取详情", actions: "读取页面", result: "已取得证据", sourceIds: [sourceId], createdAt: "2026-09-12" };
  commitArchive(dataDir, cv, { version: 1, module: "conversationHistory", entries: [summary], activeIds: [sumId], coveredSourceIds: [sourceId] }, [{ id: sourceId, content: { turnId: "tn_01", userInput: inputRecord(turns[0]!), toolIO: [tool] } }], [summary]);
  writeFileSync(join(archiveDir(dataDir, cv, "conversationHistory"), "source-ids.json"), JSON.stringify({ [JSON.stringify(["turn", "tn_01"])]: sourceId }));
  saveLedger(dataDir, ledger);
  return { cv, ledger, turns, sumId, tool };
}
const queryCall = (sumId: string, module = "toolIO") => reply([{ id: "query", name: "context_query", arguments: { reason: "查原文", sumId, module, intent: "读取详细证据" } }]);

test("query insertion triggers the 200K gate, protects current evidence, rotates and persists history", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "query-loop-"));
  try {
    const f = fixture(dataDir), registry = loadToolRegistry(repoRoot), modules = loadContextModules(repoRoot);
    const next: Turn = { ...f.turns[5]!, turnId: "tn_07", input: { id: "input_07", text: "读取详情", submittedAt: "2026-09-12" }, assembled: { ...f.turns[5]!.assembled, baseToolsIds: registry.toolGroups.baseToolsIds, toolIds: coreToolIds(registry) } };
    const previewLedger = { ...f.ledger, userInputHistory: f.turns.map(inputRecord) };
    const view = contextState(dataDir, previewLedger, next, { project: [], conversation: [] });
    const overhead = systemText(modules, pacificDate(), toolGuideFor(registry, next.assembled.baseToolsIds), {}, skillGuide(repoRoot)).length + userText({ contextModules: modules, ledger: view.ledger, turn: next, conversationSummaries: view.summaries, memories: { project: "[]", conversation: "[]" }, skillText: "", toolGuide: toolGuideFor(registry, next.assembled.toolIds) }).length;
    f.turns[1]!.input.text += "x".repeat(runtimeConfig.context.compressAtChars - overhead - 500);
    saveTurn(dataDir, f.turns[1]!); f.ledger.userInputHistory = f.turns.slice(0, -1).map(inputRecord); saveLedger(dataDir, f.ledger);
    let main = 0, compressed = 0;
    const provider: Provider = { complete: async input => {
      if (input.tools[0]?.function.name === "submitMatches") return reply([{ id: "matches", name: "submitMatches", arguments: { turnIds: ["tn_01"] } }]);
      if (input.tools[0]?.function.name === "submitTurnSummaries") {
        compressed++;
        expect(input.messages[1]!.content).not.toContain(f.tool.return.text);
        // Compression runs on the send after the one-shot nudge deferral (main===2 already sent).
        expect(main).toBe(2);
        expect(sessionView(dataDir, f.cv).activity).toMatchObject({ kind: "compressing", phase: "history" });
        expect(sessionView(dataDir, f.cv).activity?.total).toBeGreaterThan(0);
        return reply([{ id: "summaries", name: "submitTurnSummaries", arguments: { summary: "早期要求已处理完成。", actions: "已处理", result: "已完成" } }]);
      }
      main++;
      if (main === 1) { expect(compressed).toBe(0); return queryCall(f.sumId); }
      if (main === 2) {
        // Compress-prep nudge defers the 200K gate by one send when no observation is written yet.
        expect(compressed).toBe(0);
        expect(sessionView(dataDir, f.cv).activity).toBeNull();
        const values = Object.fromEntries(modules.userOrder.map(tag => {
          const id = tag.slice(1);
          const m = input.messages[1]!.content.match(new RegExp(`<${id}(?:\\s[^>]*)?>\\n[\\s\\S]*?\\n\\n内容：\\n([\\s\\S]*?)\\n</${id}>`));
          const body = m![1]!;
          return [id, id === "skill" || id === "tools" || id === "conversation" || id === "projectMemory" ? body : JSON.parse(body)];
        }));
        expect(validateUserData(values), JSON.stringify(validateUserData.errors)).toBe(true);
        // 查询直接塞进数组： main===2 时第一次查询已落账，在 <query> 里可见。
        const queries = section(input.messages[1]!.content, "query");
        const current = queries.at(-1);
        if (current.externalized) {
          expect(current.search).toBe("evidence_search");
          expect(String(current.head ?? current.summary).length).toBeGreaterThan(0);
        } else {
          expect(current.records).toEqual([f.tool]);
        }
        return queryCall(f.sumId, "userInput");
      }
      if (main === 3) {
        expect(compressed).toBeGreaterThan(0);
        expect(sessionView(dataDir, f.cv).activity).toBeNull();
        const toolIO = section(input.messages[1]!.content, "toolIO");
        const queryRow = toolIO.find((row: any) => row.name === "context_query");
        // context_query 的投影把 queryView 直接摊在 return 上（见 context/projections/tools.ts），
        // 不再包一层 result；只有被外置的 body 才是原始字符串。
        // 每批返回末尾可能挂工作区建议，解析前先裁掉。
        const result = queryRow?.return;
        const rawResult = typeof result === "string" ? result : JSON.stringify(result);
        expect(JSON.parse(rawResult)).toMatchObject({ status: "complete", sumId: f.sumId });
        expect(JSON.stringify(toolIO)).not.toContain(f.tool.return.text);
        expect(section(input.messages[1]!.content, "query")).toHaveLength(2);
        expect(section(input.messages[1]!.content, "query").map((q: any) => q.id)).toEqual(["query_01", "query_02"]);
      } else {
        expect(section(input.messages[1]!.content, "query").map((q: {turnId:string}) => q.turnId)).toEqual(["tn_07", "tn_07"]);
      }
      return finish();
    } };
    expect((await handleTurn({ repoRoot, dataDir, provider }, { userInput: "读取详情", submittedAt: "2026-09-12" })).stopReason).toEqual({ kind: "reply", text: "完成" });
    expect(loadLedger(dataDir, f.cv).queryHistory.at(-1)?.queryId).toBe("query_02");
    expect(loadIndex(dataDir, f.cv, "conversationHistory").coveredSourceIds).toContain("src_02");
    await handleTurn({ repoRoot, dataDir, provider }, { userInput: "继续", submittedAt: "2026-09-12" });
    expect(loadLedger(dataDir, f.cv).queryHistory.map(q => q.queryId)).toEqual(["query_01", "query_02"]);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("unified gate externalizes large query and cancellation preserves prior queries", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "query-pages-"));
  try {
    const f = fixture(dataDir, "原始证据".repeat(1800)); let main = 0, aux = 0;
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const provider: Provider = { complete: async input => {
      if (input.tools[0]?.function.name === "submitMatches") {
        aux++;
        if (aux === 2) { started(); await blocked; }
        return reply([{ id: "matches", name: "submitMatches", arguments: { turnIds: ["tn_01"] } }]);
      }
      main++;
      if (main === 1) return queryCall(f.sumId);
      const queries = section(input.messages[1]!.content, "query");
      const current = queries.at(-1);
      expect(current.externalized).toBe(true);
      expect(current.search).toBe("evidence_search");
      expect(current.head ?? current.summary).toBeDefined();
      expect(current.records).toEqual([]);
      return queryCall(f.sumId, "userInput");
    } };
    const running = handleTurn({ repoRoot, dataDir, provider }, { userInput: "读取详情", submittedAt: "2026-09-12" });
    await entered;
    const before = loadLedger(dataDir, f.cv).queryHistory;
    stopTurn(dataDir); release();
    expect((await running).stopReason).toEqual({ kind: "interrupted", initiatedBy: "user" });
    const after = loadLedger(dataDir, f.cv);
    expect(after.queryHistory).toEqual(before);
    // Second query was cancelled mid-flight; only the first query is stored.
    expect(after.queryHistory).toHaveLength(1);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
