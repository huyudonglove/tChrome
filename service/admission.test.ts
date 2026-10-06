import { expect, test } from "bun:test";
import { admitExecution, admitImages, admitText, admitReturn, deferredImageNote, retrievalWindowChars } from "./admission.ts";
import { buildBlockIndex, readBlock, searchBlocks, type BlockIndex } from "./evidence/index.ts";
import { runtimeConfig } from "./config/runtime.ts";
import { toolHistoryView } from "./context/projections/tools.ts";

test("externalization preserves failures and their original message through call projection", () => {
  const failure = { ok: false, faultCode: "file_not_found", error: "Missing source", message: "Read failed", recovery: "inspect_state", details: { path: "/missing.ts" } };
  const full = JSON.stringify({ ...failure, content: "x".repeat(runtimeConfig.results.inlineChars) });
  const admitted = admitReturn(full, { callId: "call_01", path: "call_01.txt" });
  if (admitted.mode !== "preview") throw new Error("Expected externalization");
  expect(admitted.payload).toMatchObject({ ...failure, externalized: true });
  expect(admitted.payload.externalizationHint).toBeString();
  expect(admitted.payload).not.toHaveProperty("content");
  const projected = toolHistoryView([{ callId: "call_01", turnId: "tn_01", name: "local_fs_read", arguments: {}, return: { stage: "complete", text: JSON.stringify(admitted.payload), totalChars: full.length } }]);
  expect(projected[0]!.return.result).toMatchObject(failure);
  const observed = toolHistoryView([{ callId: "call_01", turnId: "tn_01", name: "observation_write", arguments: {}, return: { stage: "complete", text: "{\"ok\":true}", totalChars: 11 } }],
    [{ id: "page_01", turnId: "tn_01", callId: "call_01", observedAt: "now", type: "check", result: admitted.payload }]);
  expect(observed[0]!.return.result).toMatchObject(failure);
});

test("externalized batch keeps every item status and failed path candidates visible", () => {
  const good = { ok: true, path: "/good.ts", startLine: 1, endLine: 10 };
  const bad = { ok: false, faultCode: "file_not_found", error: "Missing /test.js", candidates: ["/test.ts"] };
  const full = JSON.stringify({ ok: false, results: [{ ...good, content: "x".repeat(runtimeConfig.results.inlineChars) }, bad] });
  const admitted = admitReturn(full, { callId: "call_02", path: "call_02.txt" });
  if (admitted.mode !== "preview") throw new Error("Expected externalization");
  expect(admitted.payload).toMatchObject({ ok: false, externalized: true });
  expect(admitted.payload.results).toEqual([good, bad]);
});

test("externalization preserves success and process diagnostics without deriving a new status", () => {
  for (const state of [{ ok: true, status: "exited", exitCode: 0, passed: true }, { ok: false, status: "exited", exitCode: 1, passed: false, errorCount: 1 }]) {
    const admitted = admitText(JSON.stringify({ ...state, stdout: "x".repeat(runtimeConfig.results.inlineChars) }), { path: "process.txt" });
    if (admitted.mode !== "preview") throw new Error("Expected externalization");
    expect(admitted.payload).toMatchObject({ ...state, externalized: true });
    expect(admitted.payload).not.toHaveProperty("stdout");
  }
  for (const full of ["x".repeat(runtimeConfig.results.inlineChars + 1), JSON.stringify({ content: "x".repeat(runtimeConfig.results.inlineChars) })]) {
    const admitted = admitText(full, { path: "result.txt" });
    if (admitted.mode !== "preview") throw new Error("Expected externalization");
    expect(admitted.payload).not.toHaveProperty("ok");
    expect(admitted.payload).not.toHaveProperty("message");
  }
});

test("externalization retains partial-search and browser failure diagnostics", () => {
  for (const state of [
    { ok: true, partial: true, skipped: [{ path: "/repo/large.ts", reason: "file exceeds maxFileBytes" }], skippedCount: 1, truncated: false, truncations: [], errors: [] },
    { ok: true, partial: true, failedFrameCount: 2, lastError: "capture failed" },
    { ok: false, failureStage: "detached", detachReason: "target_closed", error: "debugger detached" },
  ]) {
    const admitted = admitText(JSON.stringify({ ...state, content: "x".repeat(runtimeConfig.results.inlineChars) }), { path: "result.txt" });
    if (admitted.mode !== "preview") throw new Error("Expected externalization");
    expect(admitted.payload).toMatchObject(state);
    expect(admitted.payload).not.toHaveProperty("content");
  }
});

test("small returns stay inline; large plain text uses the same block directory as structured data", () => {
  expect(admitText("hello", { path: "result.txt" })).toEqual({ mode: "inline", text: "hello" });
  for (const full of ["text\n".repeat(3000), JSON.stringify({ items: Array.from({ length: 500 }, (_, i) => ({ id: i, text: "value" })) })]) {
    let saved: BlockIndex | undefined;
    const admitted = admitReturn(full, { callId: "call_01", path: "call_01.txt" }, {
      persistIndex: (index) => { saved = index; return "call_01.index.json"; },
    });
    expect(admitted.mode).toBe("preview");
    if (admitted.mode !== "preview" || !saved) throw new Error("Index was not persisted");
    expect(admitted.payload.directory).toEqual(readBlock(saved, saved.rootId));
    expect(admitted.payload.rootBlockId).toBe(saved.rootId);
    expect(admitted.payload.indexPath).toBe("call_01.index.json");
    expect(admitted.payload.levels).toBeUndefined();
    expect(admitted.payload.lineWidth).toBeUndefined();
  }
});

test("code in a multi-file return resolves from the advertised tree to complete unescaped source", () => {
  const code = 'export function capture() { return "unabridged expression after the first forty characters"; }\n';
  const full = JSON.stringify({ results: [{ path: "/repo/capture.ts", startLine: 15, content: code }, { path: "/repo/log.txt", content: "log\n".repeat(3000) }] });
  const index = buildBlockIndex(full, { maxChars: retrievalWindowChars() });
  const admitted = admitReturn(full, { callId: "call_02", path: "call_02.txt" }, { index });
  expect(admitted.mode).toBe("preview");
  const hit = searchBlocks(index, "unabridged").find((hit) => hit.source.path === "/repo/capture.ts")!;
  expect(readBlock(index, hit.blockId)).toMatchObject({ kind: "content", content: code, source: { path: "/repo/capture.ts", startLine: 15 } });
});

test("retrieval block budget derives only from the existing inline budget", () => {
  expect(retrievalWindowChars()).toBe(runtimeConfig.results.inlineChars - runtimeConfig.results.pointerShellReserve);
});

test("admitImages splits by byte gate and deferred note asks for a tighter capture", () => {
  const { inline, deferred } = admitImages([
    { bytes: 10, id: "img_01" },
    { bytes: 5_000_000, id: "img_02" },
  ]);
  expect(inline.map((image) => image.id)).toEqual(["img_01"]);
  expect(deferred.map((image) => image.id)).toEqual(["img_02"]);
  const note = deferredImageNote([{ id: "img_02", path: "images/img_02.png", width: 4000, height: 3000, bytes: 5_000_000 }]);
  expect(note).toContain("img_02");
  expect(note).toContain("更精准");
  expect(deferredImageNote([])).toBe("");
});

test("admitExecution inlines a retrieval return that the tool already budgeted", () => {
  // 取回型返回（evidence_search / asset_read）自带 admitted 标记：即使超过入窗门禁也不二次外置，
  // 否则「取回→外置→再取回」会形成死循环。
  const full = JSON.stringify({ ok: true, results: [], filler: "x".repeat(runtimeConfig.results.inlineChars * 3) });
  const admitted = admitExecution(full, true, { callId: "call_01", path: "/tmp/call_01.txt" });
  expect(admitted).toEqual({ mode: "inline", text: full });
  // 产出型工具不设标记，行为与此前完全一致：仍走 admitReturn 外置成指针。
  const plain = admitExecution(full, undefined, { callId: "call_02", path: "/tmp/call_02.txt" });
  expect(plain.mode).toBe("preview");
});

test("admitExecution rejects a truthy-but-not-true admitted flag from falling through the gate", () => {
  // admitted 只认布尔 true：undefined/false 走原门禁。
  const full = "y".repeat(runtimeConfig.results.inlineChars * 2);
  for (const flag of [undefined, false]) {
    expect(admitExecution(full, flag, { path: "/tmp/x.txt" }).mode).toBe("preview");
  }
  expect(admitExecution(full, true, { path: "/tmp/x.txt" }).mode).toBe("inline");
});
