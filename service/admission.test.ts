import { expect, test } from "bun:test";
import { admitImages, admitText, deferredImageNote, payloadIndex, summarizePayload } from "./admission.ts";
import { runtimeConfig } from "./config/runtime.ts";

test("admitText inlines small text and degrades large text with a precise-fetch hint", () => {
  const small = admitText("hello", { callId: "call_01", path: "/tmp/a.txt" });
  expect(small).toEqual({ mode: "inline", text: "hello" });
  const large = admitText("x".repeat(5000), { callId: "call_01", path: "/tmp/a.txt", name: "demo" });
  expect(large.mode).toBe("preview");
  if (large.mode !== "preview") throw new Error("mode");
  expect(large.payload.externalized).toBe(true);
  expect(large.payload.preview).toBe("x".repeat(runtimeConfig.results.previewChars));
  expect(String(large.payload.message)).toContain("更精准");
  expect(String(large.payload.message)).toContain("evidence.search(windows=[{callId=call_01");
});

test("admitText turns an oversized JSON payload into a structured summary instead of a raw head slice", () => {
  const payload = {
    ok: true,
    results: [
      { ok: true, path: "/tmp/a.ts", content: "y".repeat(5000), startLine: 1, endLine: 40, totalLines: 400 },
      { ok: true, path: "/tmp/b.ts", content: "z".repeat(5000), startLine: 10, endLine: 20, totalLines: 90 },
    ],
  };
  const admitted = admitText(JSON.stringify(payload), { callId: "call_02", path: "/tmp/returns/call_02.txt", name: "local.fs_read" });
  expect(admitted.mode).toBe("preview");
  if (admitted.mode !== "preview") throw new Error("mode");
  const summary = String(admitted.payload.summary);
  expect(summary).toContain("results×2");
  expect(summary).toContain("a.ts:1-40/400");
  expect(summary).toContain("b.ts:10-20/90");
  // 目录变长后 preview 只放首行（counts 段），不再与完整目录重复。
  expect(admitted.payload.preview).toBe(summary.split("\n")[0].slice(0, runtimeConfig.results.previewChars));
  expect(admitted.payload.preview.length).toBeLessThan(summary.length);
  expect(String(admitted.payload.message)).toContain("分层目录");
  expect(String(admitted.payload.message)).toContain("preview 为首行");
  // 指针带实际存在的层级，便于判断该继续翻上层还是在明细里直接定位。
  expect(admitted.payload.levels).toEqual(["L1"]);
});

test("summarizePayload reports failures and keeps non-JSON payloads on the raw head slice", () => {
  const failed = JSON.stringify({ toolName: "local.fs_grep", ok: false, faultCode: "tool_execution_failed", message: "path must be a directory" });
  expect(summarizePayload(failed)).toContain("faultCode=tool_execution_failed");
  expect(summarizePayload(failed)).toContain("path must be a directory");
  expect(summarizePayload("not json at all")).toBe("");
  const plain = admitText("q".repeat(5000), { callId: "call_03", path: "/tmp/a.txt" });
  if (plain.mode !== "preview") throw new Error("mode");
  expect(plain.payload.summary).toBeUndefined();
  expect(plain.payload.preview).toBe("q".repeat(runtimeConfig.results.previewChars));
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

test("summarizePayload indexes HAR entries by method, path and status with failures first", () => {
  const payload = {
    ok: true,
    tabId: 1,
    stopped: true,
    entryCount: 3,
    har: {
      log: {
        version: "1.2",
        entries: [
          { startedDateTime: "a", time: 1, request: { url: "https://example.com/assets/very/long/bundle.js", method: "GET", headers: [] }, response: { status: 200 } },
          { startedDateTime: "b", time: 2, request: { url: "https://example.com/api/save", method: "POST", headers: [] }, response: { status: 500 } },
          { startedDateTime: "c", time: 3, request: { url: "https://example.com/api/list", method: "GET", headers: [] }, response: { status: 404 } },
        ],
      },
    },
  };
  const summary = summarizePayload(JSON.stringify(payload));
  expect(summary).toContain("har.log.entries×3");
  expect(summary).toContain("POST /api/save 500");
  expect(summary).toContain("GET /api/list 404");
  expect(summary.indexOf("500")).toBeLessThan(summary.indexOf("200"));
});

test("summarizePayload groups repeated grep hits by file and keeps the hit keyword", () => {
  const matches = Array.from({ length: 8 }, (_, i) => ({
    path: "/repo/src/admission.ts",
    line: i * 10 + 1,
    column: 3,
    before: "const",
    hit: "wrapCache",
    after: "",
  }));
  const summary = summarizePayload(JSON.stringify({ ok: true, toolName: "local.fs_grep", matches, scannedFiles: 120 }));
  expect(summary).toContain("tool=local.fs_grep");
  expect(summary).toContain("matches×8");
  expect(summary).toContain("admission.ts×8(");
  expect(summary).toContain('"wrapCache"');
});

test("summarizePayload scales index lines with payload size and keeps every line readable", () => {
  const gate = runtimeConfig.results.inlineChars;
  const base = (count: number) => ({
    ok: true,
    toolName: "local.fs_grep",
    scannedFiles: 200,
    matches: Array.from({ length: count }, (_, i) => ({ path: `/repo/src/mod${i}.ts`, line: i + 1, column: 1, before: "", hit: `kw${i}`, after: "" })),
  });
  const target = 16000;
  const plain = JSON.stringify(base(200)).length;
  const full = JSON.stringify({ ...base(200), filler: "x".repeat(Math.max(0, target - plain - 15)) });
  const summary = summarizePayload(full);
  const lines = summary.split("\n");
  // 分层目录：L1 明细装预算，装不下的标签由 L2 块目录接手，模型看到的都不是腰斩字串。
  expect(lines[0]).toContain("counts: matches×200");
  const indexHeader = lines.find((line) => line.startsWith("index("));
  expect(indexHeader).toBeTruthy();
  const detailCount = Number(/index\((\d+)行\)/.exec(indexHeader ?? "")?.[1] ?? 0);
  expect(detailCount).toBeGreaterThan(0);
  // 明细从第 4 行起：第 1 行 counts、第 2 行层级行、第 3 行 index(N行)。
  const detail = lines.slice(3, 3 + detailCount);
  for (const line of detail) {
    expect(line.length).toBeGreaterThanOrEqual(100);
    // 明细行里只能是完整标签，不允许出现半句话
    for (const label of line.split(", ")) expect(label).toMatch(/^mod\d+\.ts:\d+ "kw\d+"$/);
  }
  const blockHeader = lines.find((line) => /^L2块目录\(\d+块\)/.test(line));
  expect(blockHeader).toBeTruthy();
  // 块目录行会被装配器按每行字数拼成多块，逐块校验：每块都是「首标签 … 尾标签」的完整形态。
  for (const line of lines) {
    for (const token of line.split(", ")) {
      if (!token.startsWith("block")) continue;
      expect(token).toMatch(/^block\d+ mod\d+\.ts:\d+ "kw\d+"( … mod\d+\.ts:\d+ "kw\d+")?$/);
    }
  }
  expect(summary.length).toBeLessThan(gate);
});

test("summarizePayload caps index lines for huge payloads instead of growing without bound", () => {
  const gate = runtimeConfig.results.inlineChars;
  const full = JSON.stringify({
    ok: true,
    toolName: "local.fs_grep",
    filler: "x".repeat(1_000_000),
    matches: Array.from({ length: 200 }, (_, i) => ({ path: `/repo/src/mod${i}.ts`, line: i + 1, column: 1, before: "", hit: `kw${i}`, after: "" })),
  });
  const summary = summarizePayload(full);
  const lines = summary.split("\n");
  const indexHeader = lines.find((line) => line.startsWith("index(")) ?? "";
  const detailCount = Number(/index\((\d+)行\)/.exec(indexHeader)?.[1] ?? 0);
  expect(detailCount).toBeGreaterThan(0);
  expect(detailCount).toBeLessThanOrEqual(Math.floor((gate - 300) / 100));
  // L1 明细行仍要每行可读；L2 块目录行本身就是短摘要，不适用这条。
  for (const line of lines.slice(3, 3 + detailCount)) expect(line.length).toBeGreaterThanOrEqual(100);
  expect(summary.length).toBeLessThan(gate);
});

test("summarizePayload writes a full unabridged index for landing on disk", () => {
  const payload = JSON.stringify({
    ok: true,
    toolName: "local.fs_grep",
    filler: "x".repeat(1_000_000),
    matches: Array.from({ length: 200 }, (_, i) => ({ path: `/repo/src/mod${i}.ts`, line: i + 1, column: 1, before: "", hit: `kw${i}`, after: "" })),
  });
  const { labels } = payloadIndex(payload);
  expect(labels.length).toBe(200);
  expect(new Set(labels).size).toBe(200);
  expect(labels[0]).toBe('mod0.ts:1 "kw0"');
  expect(labels[199]).toBe('mod199.ts:200 "kw199"');
  for (const label of labels) expect(label).toMatch(/^mod\d+\.ts:\d+ "kw\d+"$/);
});

test("summarizePayload indexes fs_outline blocks by block number, line and preview head", () => {
  const blocks = [
    { index: 0, startOffset: 0, startLine: 1, chars: 400, preview: "# 03 解码\n读 02 的写出。" },
    { index: 1, startOffset: 400, startLine: 5, chars: 400, preview: "service/definitions/tool" },
    { index: 2, startOffset: 800, startLine: 9, chars: 400, preview: "## 栏目映射" },
  ];
  const summary = summarizePayload(JSON.stringify({ ok: true, toolName: "local.fs_outline", mode: "blocks", blocks }));
  expect(summary).toContain("blocks×3");
  expect(summary).toContain("block0 p.1");
  expect(summary).toContain("block2 p.9");
  expect(summary).toContain("## 栏目映射");
});

test("summarizePayload expands an oversized fs_read content into per-line labels and splits long lines", () => {
  const longLine = "const payload = { ".padEnd(450, "x") + "};";
  const content = ["import x from \"y\";", longLine, "return null;"].join("\n");
  const summary = summarizePayload(
    JSON.stringify({ ok: true, toolName: "local.fs_read", results: [{ path: "/repo/src/mod.ts", content, startLine: 10, endLine: 12, totalLines: 40 }] }),
  );
  expect(summary).toContain("results×1");
  expect(summary).toContain("mod.ts:10");
  expect(summary).toContain("mod.ts:11.1");
  expect(summary).toContain("mod.ts:11.3");
  expect(summary).toContain("mod.ts:12");
  expect(summary).toContain("return null;");
});

test("summarizePayload splits long CJK lines on code point boundaries", () => {
  const longLine = "中".repeat(460);
  const content = [longLine].join("\n");
  const summary = summarizePayload(
    JSON.stringify({ ok: true, toolName: "local.fs_read", results: [{ path: "/repo/src/cn.ts", content, startLine: 3, endLine: 3, totalLines: 5 }] }),
  );
  // 段数按码点算：460 字 / 200 = 3 段；用 UTF-16 切会切出 4 段（含半个代理对）
  expect(summary).toContain("cn.ts:3.1");
  expect(summary).toContain("cn.ts:3.3");
  expect(summary).not.toContain("cn.ts:3.4");
  // 片段必须是完整中文字符，不含替换符
  expect(summary).not.toContain("\uFFFD");
  expect(summary.length).toBeLessThan(runtimeConfig.results.inlineChars);
});

test("payloadIndex keeps every hit in fullLabels while L1 clusters them", () => {
  const payload = JSON.stringify({
    ok: true,
    toolName: "local.fs_grep",
    filler: "x".repeat(1_000_000),
    matches: Array.from({ length: 200 }, (_, i) => ({ path: "/repo/src/mod.ts", line: i + 1, column: 1, before: "", hit: "kw", after: "" })),
  });
  const { labels, fullLabels } = payloadIndex(payload);
  // L1 聚类：同文件 200 条折成一条。
  expect(labels.length).toBe(1);
  expect(labels[0]).toContain("mod.ts×200(");
  // L2 全量：200 条一行不缺，行号全在。
  expect(fullLabels.length).toBe(200);
  expect(fullLabels[0]).toBe('mod.ts:1 "kw"');
  expect(fullLabels[199]).toBe('mod.ts:200 "kw"');
  for (let i = 0; i < 200; i += 1) expect(fullLabels[i]).toBe(`mod.ts:${i + 1} "kw"`);
});
