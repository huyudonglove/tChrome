import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { compressRecords, partitionLoops } from "./index.ts";
import { loop, model, repoRoot } from "./test-fixtures.ts";
import { loadIndex, resolveSources } from "../../context-archive/store.ts";
import { compressionLoopsFromUserMessage } from "./protocol.ts";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const source = (id: string, type?: "userInput" | "interrupt") => ({ id, content: loop(id, type) });
function setup() { const dataDir = mkdtempSync(`${tmpdir()}/loop-compress-`); dirs.push(dataDir); return { dataDir, conversationId: "cv_test", repoRoot, module: "conversationHistory" as const }; }
test("boundaries partition by user input and interrupt; unanchored prefix splits only once", () => {
 const records = [source("loop_01"), source("loop_02"), source("loop_03"), source("loop_04", "userInput"), source("loop_05"), source("loop_06", "interrupt")];
 expect(partitionLoops(records).map(rows => rows.map(row => row.id))).toEqual([["loop_01", "loop_02"], ["loop_03"], ["loop_04", "loop_05"], ["loop_06"]]);
 expect(partitionLoops([source("loop_01")])).toHaveLength(1);
});
test("unanchored loops sent as two complete batches with exact archive provenance", async () => {
 const input = setup(), requests: string[][] = [];
 const records = Array.from({ length: 5 }, (_, i) => source(`loop_0${i + 1}`));
 const outcome = await compressRecords({ ...input, records, provider: model(request => requests.push(compressionLoopsFromUserMessage(request.messages[1]!.content).map(row => row.id))) });
 expect(requests).toEqual([["loop_01", "loop_02", "loop_03"], ["loop_04", "loop_05"]]);
 expect(outcome).toEqual({ status: "completed", committedLoopIds: records.map(row => row.id), totalLoops: 5 });
 const index = loadIndex(input.dataDir, input.conversationId, input.module);
 expect(index.entries.map(row => row.loopIds)).toEqual(requests);
 expect(resolveSources(input.dataDir, input.conversationId, input.module, index.activeIds)).toEqual(records);
});
test("multiple valid summaries cover the whole batch atomically", async () => {
 const input = setup();
 await compressRecords({ ...input, records: [source("loop_01", "userInput"), source("loop_02")], provider: model(undefined, 3) });
 const index = loadIndex(input.dataDir, input.conversationId, input.module);
 expect(index.entries).toHaveLength(3);
 expect(index.entries.every(row => JSON.stringify(row.loopIds) === '["loop_01","loop_02"]')).toBe(true);
});
test("failure stops later batches without covering failed sources or retrying format", async () => {
 const input = setup(); let calls = 0;
 const good = model();
 const outcome = await compressRecords({ ...input, records: [source("loop_01", "userInput"), source("loop_02", "interrupt"), source("loop_03", "userInput")], provider: { async complete(request) { calls++; const response = await good.complete(request); if (calls === 2) response.toolCalls[0]!.arguments = { summary: "invalid" }; return response; } } });
 expect(calls).toBe(2);
 expect(outcome).toMatchObject({ status: "stopped", committedLoopIds: ["loop_01"], failedLoopIds: ["loop_02"] });
 expect(loadIndex(input.dataDir, input.conversationId, input.module).coveredSourceIds).toEqual(["loop_01"]);
});
test("covered sources are not recompressed; no new sources means no summary folding", async () => {
 const input = setup(), records = [source("loop_01")];
 await compressRecords({ ...input, records, provider: model() });
 expect(await compressRecords({ ...input, records, provider: { complete: async () => { throw new Error("must not request"); } } })).toEqual({ status: "noop", committedLoopIds: [], totalLoops: 0 });
});
test("cancellation before commit retains originals", async () => {
 const input = setup(); let cancelled = false;
 await expect(compressRecords({ ...input, records: [source("loop_01")], isCancelled: () => cancelled, provider: model(() => { cancelled = true; }) })).rejects.toThrow("cancelled");
 expect(loadIndex(input.dataDir, input.conversationId, input.module).coveredSourceIds).toEqual([]);
});
test("a partially committed walk resumes uncovered sources and retains source order", async () => {
 const input = setup(), records = [source("loop_01", "userInput"), source("loop_02", "interrupt"), source("loop_03")];
 let calls = 0;
 const good = model();
 await compressRecords({ ...input, records, provider: { async complete(request) { if (++calls === 2) throw new Error("offline"); return good.complete(request); } } });
 const sent: string[][] = [];
 const result = await compressRecords({ ...input, records, provider: model(request => sent.push(compressionLoopsFromUserMessage(request.messages[1]!.content).map(row => row.id))) });
 expect(result.committedLoopIds).toEqual(["loop_02", "loop_03"]);
 expect(sent).toEqual([["loop_02", "loop_03"]]);
 const index = loadIndex(input.dataDir, input.conversationId, input.module);
 expect(resolveSources(input.dataDir, input.conversationId, input.module, [...index.activeIds].reverse()).map(row => row.id)).toEqual(records.map(row => row.id));
});
test("folded summaries preserve every original loop ID and resolve complete source history", async () => {
 const input = setup();
 const records = Array.from({ length: 24 }, (_, i) => source(`loop_${String(i + 1).padStart(2, "0")}`, "userInput"));
 await compressRecords({ ...input, records, provider: model() });
 const index = loadIndex(input.dataDir, input.conversationId, input.module);
 const active = index.activeIds.map(id => index.entries.find(row => row.id === id)!);
 expect(active.some(row => row.level === 2)).toBe(true);
 expect(new Set(active.flatMap(row => row.loopIds))).toEqual(new Set(records.map(row => row.id)));
 expect(resolveSources(input.dataDir, input.conversationId, input.module, index.activeIds)).toEqual(records);
});
