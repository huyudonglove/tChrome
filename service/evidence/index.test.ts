import { describe, expect, test } from "bun:test";
import { buildBlockIndex, readBlock, searchBlocks, type BlockIndex } from "./index.ts";

function assertCoverage(index: BlockIndex, maxChars: number): void {
  const reachable = new Set<string>();
  function walk(id: string): void {
    expect(reachable.has(id)).toBe(false);
    reachable.add(id);
    const result = readBlock(index, id)!;
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(maxChars);
    if (result.kind === "directory") {
      expect(result.children.length).toBeGreaterThan(0);
      for (const child of result.children) {
        expect(index.nodes.find((node) => node.id === child.blockId)?.parentId).toBe(id);
        walk(child.blockId);
      }
    }
  }
  walk(index.rootId);
  expect(reachable.size).toBe(index.nodes.length);
  for (const source of index.sources) {
    const leaves = index.nodes.filter((node) => node.sourceId === source.id && !node.children.length)
      .sort((a, b) => a.start - b.start);
    let cursor = 0;
    let reconstructed = "";
    for (const leaf of leaves) {
      expect(leaf.start).toBe(cursor);
      const read = readBlock(index, leaf.id)!;
      expect(read.kind).toBe("content");
      if (read.kind === "content") {
        expect(read.content).toBe(source.text.slice(leaf.start, leaf.end));
        reconstructed += read.content;
      }
      cursor = leaf.end;
    }
    expect(cursor).toBe(source.text.length);
    expect(reconstructed).toBe(source.text);
  }
}

describe("uniform immutable evidence blocks", () => {
  test("keeps code functions whole when they fit and descends inside a large function", () => {
    const small = "export function small() { return 'complete expression, including its tail'; }\n";
    const large = `export function large() {\n${Array.from({ length: 50 }, (_, i) => `  const value${i} = ${i}; // a meaningful statement\n`).join("")}  return value49;\n}\n`;
    const index = buildBlockIndex(small + large + small, { path: "/repo/module.ts", maxChars: 700 });
    assertCoverage(index, 700);
    expect(index.nodes.some((node) => node.title === "large" && node.children.length > 0)).toBe(true);
    const hit = searchBlocks(index, "complete expression")[0]!;
    const read = readBlock(index, hit.blockId)!;
    expect(read.kind === "content" && read.content).toContain(small.trim());
    expect(hit.source.path).toBe("/repo/module.ts");
  });

  test("plain text, a giant unbroken line and Unicode preserve all original characters", () => {
    const inputs = ["", "第一段。\n\n第二段。\n".repeat(140), '"\\\t😀'.repeat(1000), "abcdef".repeat(1500)];
    for (const text of inputs) {
      const index = buildBlockIndex(text, { maxChars: 700 });
      assertCoverage(index, 700);
      for (const node of index.nodes.filter((item) => !item.children.length)) {
        const read = readBlock(index, node.id)!;
        if (read.kind === "content") {
          expect(read.content).not.toMatch(/^[\uDC00-\uDFFF]/);
          expect(read.content).not.toMatch(/[\uD800-\uDBFF]$/);
        }
      }
    }
  });

  test("nested JSON uses the same tree and groups large directories without truncation", () => {
    const full = JSON.stringify({ rows: Array.from({ length: 130 }, (_, i) => ({ id: i, text: `row${i}: ${"data ".repeat(60)}` })) }, null, 2);
    const index = buildBlockIndex(full, { maxChars: 900 });
    assertCoverage(index, 900);
    const hits = searchBlocks(index, "row129:");
    expect(hits).toHaveLength(1);
    expect(readBlock(index, hits[0]!.blockId)?.kind).toBe("content");
    expect(readBlock(index, "blk_missing")).toBeUndefined();
    expect(searchBlocks(index, "")).toEqual([]);
    expect(searchBlocks(index, "absent-keyword")).toEqual([]);
  });

  test("keyword search maps a match crossing a leaf boundary to both complete blocks", () => {
    const text = Array.from({ length: 3000 }, (_, i) => i.toString(36).padStart(4, "0")).join("");
    const index = buildBlockIndex(text, { maxChars: 700 });
    const leaves = index.nodes.filter((node) => !node.children.length).sort((a, b) => a.start - b.start);
    const boundary = leaves[0]!.end;
    const keyword = text.slice(boundary - 8, boundary + 8);
    const hits = searchBlocks(index, keyword);
    expect(hits.map((hit) => hit.blockId)).toContain(leaves[0]!.id);
    expect(hits.map((hit) => hit.blockId)).toContain(leaves[1]!.id);
    expect(new Set(hits.map((hit) => hit.blockId)).size).toBe(hits.length);
    expect(hits[0]!.snippet).toContain(keyword);
  });

  test("keyword results navigate through parent directories to adjacent full blocks", () => {
    const text = Array.from({ length: 80 }, (_, i) => `Paragraph ${i}: ${"complete text ".repeat(15)}\n\n`).join("");
    const index = buildBlockIndex(text, { maxChars: 1000 });
    assertCoverage(index, 1000);
    const hit = searchBlocks(index, "Paragraph 40:")[0]!;
    expect(hit.parentBlockId).toBeDefined();
    const content = readBlock(index, hit.blockId)!;
    expect(content.parentBlockId).toBe(hit.parentBlockId);
    const parent = readBlock(index, hit.parentBlockId!)!;
    expect(parent.kind).toBe("directory");
    if (parent.kind === "directory") {
      const position = parent.children.findIndex((child) => child.blockId === hit.blockId);
      const sibling = parent.children[position + 1] ?? parent.children[position - 1];
      expect(sibling).toBeDefined();
      expect(sibling!.parentBlockId).toBe(parent.blockId);
      expect(readBlock(index, sibling!.blockId)?.kind).toBe("content");
    }
    expect(readBlock(index, index.rootId)?.parentBlockId).toBeUndefined();
  });

  test("file-read snapshots expose decoded code with source line mapping and persist losslessly", () => {
    const code = Array.from({ length: 35 }, (_, i) => `export const item${i} = "${"x".repeat(45)}";`).join("\n");
    const full = JSON.stringify({ results: [{ path: "/repo/a.ts", startLine: 80, content: code },
      { path: "/repo/b.txt", content: "a full second source\n".repeat(40) }] });
    const original = buildBlockIndex(full, { maxChars: 1000 });
    const index = JSON.parse(JSON.stringify(original)) as BlockIndex;
    expect(index.sources).toHaveLength(3);
    expect(index.sources[0]!.text).toBe(full);
    expect(index.sources[1]!.text).toBe(code);
    assertCoverage(index, 1000);
    const first = index.nodes.find((node) => node.sourceId === index.sources[1]!.id && !node.children.length && node.start === 0)!;
    const read = readBlock(index, first.id)!;
    expect(read.kind).toBe("content");
    if (read.kind === "content") {
      expect(read.source).toMatchObject({ path: "/repo/a.ts", startLine: 80, jsonPath: "$.results[0].content" });
      expect(read.content).toContain('export const item0 = "');
    }
    expect(buildBlockIndex(full, { maxChars: 1000 })).toEqual(original);
  });
});
