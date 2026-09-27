import { expect, test } from "bun:test";
import { admitImages, admitText, buildLevels, deferredImageNote, indexTree, payloadIndex, retrievalWindowChars, summarizePayload } from "./admission.ts";
import { runtimeConfig } from "./config/runtime.ts";

test("admitText inlines small text and degrades large text with a precise-fetch hint", () => {
  const small = admitText("hello", { callId: "call_01", path: "/tmp/a.txt" });
  expect(small).toEqual({ mode: "inline", text: "hello" });
  const large = admitText("x".repeat(5000), { callId: "call_01", path: "/tmp/a.txt", name: "demo" });
  expect(large.mode).toBe("preview");
  if (large.mode !== "preview") throw new Error("mode");
  expect(large.payload.externalized).toBe(true);
  expect(large.payload.head).toBe("x".repeat(runtimeConfig.results.previewChars));
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
  // 目录已带全文信息，不再重复一份头部（payload.preview 已移除）。
  expect(admitted.payload.preview).toBeUndefined();
  expect(admitted.payload.head).toBeUndefined();
  expect(String(admitted.payload.message)).toContain("分层目录");
  expect(String(admitted.payload.message)).not.toContain("preview");
  // 指针带实际存在的层级，便于判断该继续翻上层还是在明细里直接定位。
  // 两个大文本各切出多行标签，L1 装得下但需要分块 → 折出 L2 块目录，levels 按实际存在的层给出。
  expect(admitted.payload.levels).toEqual(["L1", "L2"]);
});

test("summarizePayload reports failures and keeps non-JSON payloads on the raw head slice", () => {
  const failed = JSON.stringify({ toolName: "local.fs_grep", ok: false, faultCode: "tool_execution_failed", message: "path must be a directory" });
  expect(summarizePayload(failed)).toContain("faultCode=tool_execution_failed");
  expect(summarizePayload(failed)).toContain("path must be a directory");
  expect(summarizePayload("not json at all")).toBe("");
  const plain = admitText("q".repeat(5000), { callId: "call_03", path: "/tmp/a.txt" });
  if (plain.mode !== "preview") throw new Error("mode");
  expect(plain.payload.summary).toBeUndefined();
  expect(plain.payload.head).toBe("q".repeat(runtimeConfig.results.previewChars));
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
  // 分层索引树里 L1 是全量明细，不再按文件折叠成一条，聚类只喂落盘清单。
  expect(summary).toContain("L1明细(共8条");
  expect(summary).toContain("L1.1");
  expect(summary).toContain('admission.ts:1 "wrapCache"');
  expect(summary).toContain('admission.ts:71 "wrapCache"');
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
  // 分层索引树：第 1 行 counts，之后是层级标题「L1明细(共N条，M块可寻址)」，再往后每块以块 id 起头。
  const title = lines.find((line) => line.startsWith("L1明细(")) ?? "";
  expect(title).toBeTruthy();
  const chunkCount = Number(/，(\d+)块可寻址/.exec(title)?.[1] ?? 0);
  expect(chunkCount).toBeGreaterThan(0);
  const detail = lines.filter((line) => line.startsWith("mod"));
  expect(detail.length).toBeGreaterThan(0);
  for (const line of detail) {
    // 明细行里只能是完整标签，不允许出现半句话
    for (const label of line.split(", ")) expect(label).toMatch(/^mod\d+\.ts:\d+ "kw\d+"$/);
  }
  const blockHeader = lines.find((line) => /^L2块目录\(共\d+块/.test(line));
  expect(blockHeader).toBeTruthy();
  // L2 是 L1 的上层封装，且是严格二分：每块 = 两个 L1 块各取一半正文
  // （形如 `L1.1-L1.2 <L1.1 的前半> … <L1.2 的前半>`，半块内部用 ⏎ 标行边界）。
  const l1 = indexTree(full)!.levels.find((level) => level.id === "L1")!;
  const l2 = indexTree(full)!.levels.find((level) => level.id === "L2")!;
  expect(l2).toBeDefined();
  expect(l2.total).toBe(l1.chunks.length);
  expect(l2.chunks.length).toBe(Math.ceil(l1.chunks.length / 2));
  for (let i = 0; i < l2.chunks.length; i += 1) {
    const a = l1.chunks[i * 2]!;
    const b = l1.chunks[i * 2 + 1];
    const chunk = l2.chunks[i]!;
    expect(chunk.text.startsWith(b ? `${a.id}-${b.id} ` : `${a.id} `)).toBe(true);
    expect(chunk.chars).toBe(chunk.text.length);
    expect(chunk.chars).toBeLessThanOrEqual(gate);
  }
  // 渲染层每块都有痕迹：装得下给正文，装不下给 id+区间 stub，不整块消失
  for (const chunk of l2.chunks) expect(summary).toContain(chunk.id);
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
  const title = lines.find((line) => line.startsWith("L1明细(")) ?? "";
  const chunkCount = Number(/，(\d+)块可寻址/.exec(title)?.[1] ?? 0);
  // 每层各自独立寻址：1MB 载荷下 L1 也只出有限块，完整清单交给上层块目录与落盘文件。
  expect(chunkCount).toBeGreaterThan(0);
  expect(chunkCount).toBeLessThanOrEqual(10);
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

test("buildLevels keeps every label addressable: L1 is the full detail, L2 wraps L1", () => {
  const labels = Array.from({ length: 200 }, (_, i) => `mod.ts:${i + 1} "${"x".repeat(30)}"`);
  const tree = buildLevels("counts: matches×200", labels);
  expect(tree.head).toContain("matches×200");
  const l1 = tree.levels[0]!;
  expect(l1.id).toBe("L1");
  expect(l1.name).toBe("L1明细");
  expect(l1.total).toBe(200);
  // 载荷大于门禁，L1 必然切成多块，每块一个可寻址 id
  expect(l1.chunks.length).toBeGreaterThan(1);
  expect(l1.chunks[0]!.id).toBe("L1.1");
  // 每块都在门禁内，层内不腰斩、不出 …(+n)
  for (const chunk of l1.chunks) {
    expect(chunk.chars).toBeLessThanOrEqual(runtimeConfig.results.inlineChars);
    expect(chunk.text).not.toContain("…(+");
  }
  // L1 全量条目都在（首尾各抽查）
  const l1Text = l1.chunks.map((chunk) => chunk.text).join("\n");
  expect(l1Text).toContain('mod.ts:1 "');
  expect(l1Text).toContain('mod.ts:200 "');
  // L2 是 L1 的上层封装：total 等于 L1 块数，标签带下层 id 区间
  const l2 = tree.levels.find((level) => level.id === "L2")!;
  expect(l2).toBeDefined();
  expect(l2.name).toBe("L2块目录");
  expect(l2.total).toBe(l1.chunks.length);
  expect(l2.chunks[0]!.text).toContain("L1.1");
  for (const level of tree.levels) {
    for (const chunk of level.chunks) expect(chunk.chars).toBeLessThanOrEqual(runtimeConfig.results.inlineChars);
  }
});

test("indexTree builds a tree for oversized payloads and returns null when no facts can be extracted", () => {
  const payload = JSON.stringify({
    ok: true,
    toolName: "local.fs_grep",
    filler: "x".repeat(50_000),
    matches: Array.from({ length: 200 }, (_, i) => ({ path: "/repo/src/mod.ts", line: i + 1, column: 1, before: "", hit: "kw", after: "y".repeat(30) })),
  });
  const tree = indexTree(payload);
  expect(tree).not.toBeNull();
  expect(tree!.head).toContain("matches×200");
  expect(tree!.levels[0]!.chunks.length).toBeGreaterThan(1);
  // 纯文本没有可抽事实 → null，调用方回退原文切片
  expect(indexTree("just a plain sentence without any structured facts")).toBeNull();
});

test("admitText puts per-layer addressable chunk ids into the pointer payload", () => {
  const payload = JSON.stringify({
    ok: true,
    toolName: "local.fs_grep",
    filler: "x".repeat(50_000),
    matches: Array.from({ length: 200 }, (_, i) => ({ path: "/repo/src/mod.ts", line: i + 1, column: 1, before: "", hit: "kw", after: "y".repeat(30) })),
  });
  const admitted = admitText(payload, { callId: "call_01", path: "/tmp/a.txt", name: "local.fs_grep", indexPath: "/tmp/a.index.json" });
  expect(admitted.mode).toBe("preview");
  if (admitted.mode !== "preview") throw new Error("mode");
  const layers = admitted.payload.layers as { id: string; name: string; total: number; chunks: { id: string; from: number; to: number; chars: number }[] }[];
  expect(Array.isArray(layers)).toBe(true);
  const l1 = layers.find((level) => level.id === "L1")!;
  expect(l1).toBeDefined();
  expect(l1.name).toBe("L1明细");
  expect(l1.total).toBe(200);
  expect(l1.chunks.length).toBeGreaterThan(1);
  // 块 id 可直接喂给 evidence.search 的 levelId，且每块在门禁内
  for (const chunk of l1.chunks) {
    expect(chunk.id).toMatch(/^L1\.\d+$/);
    expect(chunk.to).toBeGreaterThanOrEqual(chunk.from);
    expect(chunk.chars).toBeLessThanOrEqual(runtimeConfig.results.inlineChars);
  }
  // 块正文不进指针，只带元数据
  expect(JSON.stringify(layers)).not.toContain("mod.ts:1 ");
  // 纯文本载荷抽不出层级 → 不带 layers
  const plain = admitText("z".repeat(5000), { callId: "call_02", path: "/tmp/b.txt" });
  if (plain.mode !== "preview") throw new Error("mode");
  expect(plain.payload.layers).toBeUndefined();
});

test("summarizePayload keeps a stub for every chunk and never drops a whole level", () => {
  const gate = runtimeConfig.results.inlineChars;
  const full = JSON.stringify({
    ok: true,
    toolName: "local.fs_grep",
    scannedFiles: 200,
    filler: "x".repeat(60_000),
    matches: Array.from({ length: 200 }, (_, i) => ({ path: `/repo/src/mod${i}.ts`, line: i + 1, column: 1, before: "", hit: `kw${i}`, after: "" })),
  });
  const tree = indexTree(full);
  expect(tree).not.toBeNull();
  const summary = summarizePayload(full, tree);
  // 预算不够时按块降级：每层标题都在，每个块都有痕迹（正文或 id+区间 stub）。
  for (const level of tree!.levels) {
    expect(summary).toContain(`${level.name}(共${level.total}`);
    for (const chunk of level.chunks) expect(summary).toContain(chunk.id);
  }
  expect(summary).toContain("（按 id 取回）");
  expect(summary.length).toBeLessThan(gate);
});

test("buildLevels halves the chunk count per level and keeps both halves in the parent block", () => {
  const labels = Array.from({ length: 200 }, (_, i) => `mod${i}.ts:${i + 1} "${"x".repeat(60)}kw${i}"`);
  const tree = buildLevels("counts: x", labels);
  const l1 = tree.levels[0]!;
  // 标签够长才会切出 8 块，才能看出 8 → 4 → 2 的金字塔
  expect(l1.chunks.length).toBe(8);
  for (const level of tree.levels.slice(1)) {
    const prev = tree.levels[tree.levels.indexOf(level) - 1]!;
    expect(level.total).toBe(prev.chunks.length);
    expect(level.chunks.length).toBe(Math.ceil(prev.chunks.length / 2));
    // 每个父块由两个子块各取一半正文拼成，最后一个可能只带单个子块
    level.chunks.forEach((chunk, i) => {
      const a = prev.chunks[i * 2]!;
      const b = prev.chunks[i * 2 + 1];
      expect(chunk.id).toBe(`${level.id}.${i + 1}`);
      expect(chunk.from).toBe(a.from);
      expect(chunk.to).toBe((b ?? a).to);
      expect(chunk.text.startsWith(b ? `${a.id}-${b.id} ` : `${a.id} `)).toBe(true);
      expect(chunk.text).toContain(a.text.split("\n")[0]!.slice(0, 40));
      if (b) expect(chunk.text).toContain(b.text.split("\n")[0]!.slice(0, 40));
      expect(chunk.chars).toBe(chunk.text.length);
    });
  }
  expect(tree.levels.map((level) => level.id)).toEqual(["L1", "L2", "L3"]);
});

test("retrieval window shares the inline gate instead of a separate retrieval limit", () => {
  const gate = runtimeConfig.results.inlineChars;
  const window = retrievalWindowChars();
  // 唯一门禁：取回窗口 = 入窗门禁 - 指针壳，加回壳后必须仍小于门禁，结构上不可能套指针。
  expect(window).toBe(gate - 400);
  expect(window).toBeLessThan(gate);
  expect(window).toBeGreaterThanOrEqual(100);
});
