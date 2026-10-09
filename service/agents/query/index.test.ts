import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { commitArchive } from "../../context-archive/store.ts";
import { emptyLedger, saveLedger } from "../../runtime/store.ts";
import { queryContext } from "./index.ts";
import { queryLoopsFromUserMessage } from "./protocol.ts";
import { loop, repoRoot } from "../compression/test-fixtures.ts";
import type { CompressionRecord } from "../../context-archive/types.ts";
import type { Provider } from "../../types.ts";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function fixture() {
 const dataDir = mkdtempSync(`${tmpdir()}/loop-query-`); dirs.push(dataDir);
 const loops = [loop("loop_01"), loop("loop_02")];
 loops[0]!.runtime = [{ id: "rt_01", type: "callsResult", content: { callId: "call_01", args: { path: "src/auth.ts" }, result: "token 校验" } }];
 const ledger = emptyLedger("cv_test"); ledger.loops = loops; saveLedger(dataDir, ledger);
 const entries: CompressionRecord[] = loops.map((row, i) => ({ id: `sum_0${i + 1}`, module: "conversationHistory", loopIds: [row.id], level: 1, summary: "检查", userRequest: "检查", actions: "读取", result: "通过", sourceIds: [row.id], createdAt: "2026-10-09" }));
 commitArchive(dataDir, "cv_test", { version: 1, module: "conversationHistory", entries, activeIds: entries.map(row => row.id), coveredSourceIds: loops.map(row => row.id) }, loops.map(row => ({ id: row.id, content: row })), entries);
 return { dataDir, conversationId: "cv_test", repoRoot, module: "runtime" as const, intent: "token 校验" };
}
function provider(observe?: (request: Parameters<Provider["complete"]>[0]) => void, ids = ["loop_01"]): Provider {
 return { async complete(request) { observe?.(request); return { finish: "tool_calls", content: "", toolCalls: [{ id: "call_match", name: "submitMatches", arguments: { loopIds: ids } }], attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [] }; } };
}
test("summary traversal preserves source loop and runtime identities", async () => {
 const result = await queryContext({ ...fixture(), sumId: "sum_01", provider: provider(request => {
  const data = queryLoopsFromUserMessage(request.messages[1]!.content);
  expect(data.loops.map(row => row.loopId)).toEqual(["loop_01"]);
 }) });
 expect(result).toMatchObject({ status: "complete", records: [{ id: "rt_01", loopId: "loop_01" }] });
});
test("direct loop retrieval needs no summary and remains conversation scoped", async () => {
 const input = fixture();
 expect(await queryContext({ ...input, loopId: "loop_01", provider: provider() })).toMatchObject({ status: "complete", loopId: "loop_01" });
 expect(await queryContext({ ...input, loopId: "loop_99", provider: provider(() => { throw new Error("no request"); }) })).toMatchObject({ status: "not_found", records: [] });
});
test("file filter examines nested call arguments and misses without a model call", async () => {
 const input = fixture();
 expect(await queryContext({ ...input, sumId: "sum_01", file: "auth.ts", provider: provider() })).toMatchObject({ status: "complete" });
 expect(await queryContext({ ...input, sumId: "sum_01", file: "other.ts", provider: provider(() => { throw new Error("no request"); }) })).toMatchObject({ status: "not_found" });
});
test("out-of-source selection and ambiguous IDs fail without returning evidence", async () => {
 const input = fixture();
 expect(await queryContext({ ...input, sumId: "sum_01", provider: provider(undefined, ["loop_02"]) })).toMatchObject({ status: "error", records: [] });
 expect(await queryContext({ ...input, sumId: "sum_01", loopId: "loop_01", provider: provider() })).toMatchObject({ status: "error", records: [] });
});
