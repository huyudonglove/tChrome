import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { emptyLedger } from "./store.ts";
import { contextState, compressContext } from "./context-state.ts";
import { loop, model, repoRoot } from "../agents/compression/test-fixtures.ts";
import { loadIndex, resolveSources } from "../context-archive/store.ts";
import type { Turn } from "../types.ts";
import type { Memories } from "../memory/types.ts";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function fixture() {
 const dataDir = mkdtempSync(`${tmpdir()}/loop-state-`); dirs.push(dataDir);
 const ledger = emptyLedger("cv_test");
 ledger.loops = [loop("loop_01", "userInput"), loop("loop_02"), loop("loop_03", "interrupt"), loop("loop_04")];
 ledger.loops[0]!.helm!.calls = [{ id: "call_memory", name: "memory.write", arguments: { text: "历史记忆" } }];
 const memories: Memories = { project: [], conversation: [{ memoryId: "mm_01", turnId: "tn_01", layer: "conversation", text: "历史记忆", createdAt: "2026-10-09", sourceCallId: "call_memory" }, { memoryId: "mm_02", turnId: "tn_01", layer: "conversation", text: "当前记忆", createdAt: "2026-10-09", sourceCallId: "call_current" }] };
 const turn = { turnId: "tn_01", conversationId: "cv_test" } as Turn;
 return { dataDir, repoRoot, ledger, turn, memories, provider: model(), isCancelled: () => false };
}
test("only newest loop survives projection; immutable originals and memory source provenance remain", async () => {
 const input = fixture(); const before = JSON.stringify(input.ledger);
 expect(await compressContext(input)).toMatchObject({ status: "completed", committedLoopIds: ["loop_01", "loop_02", "loop_03"] });
 const view = contextState(input.dataDir, input.ledger, input.turn, input.memories);
 expect(view.ledger.loops.map(row => row.id)).toEqual(["loop_04"]);
 expect(view.memories.conversation.map(row => row.memoryId)).toEqual(["mm_02"]);
 expect(JSON.stringify(input.ledger)).toBe(before);
 const index = loadIndex(input.dataDir, "cv_test", "conversationHistory");
 expect(resolveSources(input.dataDir, "cv_test", "conversationHistory", index.activeIds).map(row => row.id)).toEqual(["loop_01", "loop_02", "loop_03"]);
});
test("one newest loop alone never requests compression or emits activity", async () => {
 const input = fixture(); input.ledger.loops = [loop("loop_01")];
 let starts = 0;
 const result = await compressContext({ ...input, onStart: () => starts++, provider: { complete: async () => { throw new Error("must not request"); } } });
 expect(result.status).toBe("noop"); expect(starts).toBe(0);
});
test("subsequent compression covers newly eligible loops without rewriting prior sources", async () => {
 const input = fixture(); await compressContext(input);
 input.ledger.loops.push(loop("loop_05"));
 expect(await compressContext(input)).toMatchObject({ committedLoopIds: ["loop_04"], totalLoops: 1 });
 expect(contextState(input.dataDir, input.ledger, input.turn, input.memories).ledger.loops.map(row => row.id)).toEqual(["loop_05"]);
});
