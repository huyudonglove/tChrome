import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { commitArchive } from "../../context-archive/store.ts";
import { queryContext } from "./index.ts";
import type { CompressionRecord, SourceRecord } from "../../context-archive/types.ts";
import type { Provider } from "../../types.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const repoRoot = resolve(import.meta.dir, "../../..");
function fixture(contents: unknown[] = [{ id: "raw_0", turnId: "tn_0", userInput: "只改负责人", submittedAt: "2026-09-01" }, { id: "raw_1", userInput: "状态保持待处理" }]) {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-query-")); dirs.push(dataDir);
  const sources: SourceRecord[] = contents.map((content, i) => ({ id: `raw_${i}`, content }));
  const records: CompressionRecord[] = sources.map((source, i) => ({ id: `sum_${i}`, module: "userInputHistory", level: 1,
    tag: "修改限制", summary: "关于修改负责人和状态的限制", sourceIds: [source.id], createdAt: `2026-09-0${i + 1}` }));
  if (records.length > 1) records.push({ id: "sum_parent", module: "userInputHistory", level: 2, tag: "修改限制", summary: "历史修改规则",
    sourceIds: records.map(record => record.id), createdAt: "2026-09-09" });
  commitArchive(dataDir, "cv_test", { version: 1, module: "userInputHistory", entries: records,
    activeIds: records.length > 1 ? ["sum_parent"] : records.map(r => r.id), coveredSourceIds: sources.map(s => s.id) }, sources, records);
  return { dataDir, conversationId: "cv_test", module: "userInputHistory" as const, tag: "任务的修改限制", repoRoot };
}
function providerFor(ids: string[], observe?: (input: Parameters<Provider["complete"]>[0]) => void): Provider {
  return { async complete(input) { observe?.(input); return { finish: "tool_calls", content: "", toolCalls: [{ id: "call_matches", name: "submitMatches", arguments: { ids } }], attempts: 1,
    parseOk: true, schemaOk: true, faultCode: null, missing: [] }; } };
}

test("query uses independent return-tool request, unfolds hierarchy chronologically and removes only storage metadata", async () => {
  const input = fixture();
  const result = await queryContext({ ...input, provider: providerFor(["sum_1", "sum_parent", "sum_0"], request => {
    expect(request.tools.map(tool => tool.function.name)).toEqual(["submitMatches"]);
    expect(JSON.parse(request.messages[1]!.content).request).toMatchObject({ module: "userInputHistory", tag: input.tag });
  }) });
  expect(result).toMatchObject({ ok: true, status: "complete", matchedRecords: 2, returnedRecords: 2, omittedRecords: 0 });
  expect(result.contents).toEqual([{ userInput: "只改负责人", submittedAt: "2026-09-01" }, { userInput: "状态保持待处理" }]);
  expect(JSON.stringify(result)).not.toContain("sum_");
});

test("query validates candidates against module directory and does not expose partial matches after invalid output", async () => {
  const input = fixture();
  const result = await queryContext({ ...input, provider: providerFor(["sum_0", "../outside"]) });
  expect(result.status).toBe("error");
  expect(result.contents).toEqual([]);
  expect((await queryContext({ ...input, module: "toolIO", provider: providerFor(["sum_0"]) })).status).toBe("not_found");
});

test("empty semantic match is not_found and cancellation prevents calls", async () => {
  const input = fixture();
  expect((await queryContext({ ...input, provider: providerFor([]) })).status).toBe("not_found");
  expect((await queryContext({ ...input, isCancelled: () => true, provider: providerFor([], () => { throw new Error("must not call"); }) })).status).toBe("cancelled");
});

test("large original returns explicit partial with complete prefix and does not clip or skip", async () => {
  const input = fixture([{ userInput: "first" }, { userInput: "x".repeat(31000) }, { userInput: "last" }]);
  const result = await queryContext({ ...input, provider: providerFor(["sum_parent"]) });
  expect(result).toMatchObject({ ok: true, status: "partial", contents: [{ userInput: "first" }], matchedRecords: 3, omittedRecords: 2 });
});

test("directory batches are bounded and all batches are queried before declaring no matches", async () => {
  const input = fixture(Array.from({ length: 300 }, (_, i) => ({ userInput: `record ${i}` })));
  let calls = 0;
  const provider = providerFor([], request => {
    calls++;
    const payload = JSON.parse(request.messages[1]!.content);
    expect(JSON.stringify(payload.catalog).length).toBeLessThanOrEqual(24000);
  });
  const result = await queryContext({ ...input, provider });
  expect(result.status).toBe("not_found");
  expect(calls).toBeGreaterThan(1);
});

test("later directory failure does not return earlier candidates as complete results", async () => {
  const input = fixture(Array.from({ length: 300 }, (_, i) => ({ userInput: `record ${i}` })));
  let calls = 0;
  const provider: Provider = { async complete(request) {
    calls++;
    if (calls === 2) throw new Error("provider unavailable");
    const entries = JSON.parse(request.messages[1]!.content).entries;
    return { finish: "tool_calls", content: "", toolCalls: [{ id: "call_matches", name: "submitMatches", arguments: { ids: [entries[0].id] } }], attempts: 1,
      parseOk: true, schemaOk: true, faultCode: null, missing: [] };
  } };
  const result = await queryContext({ ...input, provider });
  expect(result.status).toBe("error");
  expect(result.contents).toEqual([]);
});

test("query preserves original operational target refs and full result bodies", async () => {
  const input = fixture([{ id: "source_0", callId: "call_0", name: "page.click", arguments: { id: "e1", ref: "el_target", text: "preserve" },
    return: { text: "original full text", totalChars: 18 } }]);
  const result = await queryContext({ ...input, provider: providerFor(["sum_0"]) });
  expect(result.contents).toEqual([{ name: "page.click", arguments: { id: "e1", ref: "el_target", text: "preserve" },
    return: { text: "original full text", totalChars: 18 } }]);
});
