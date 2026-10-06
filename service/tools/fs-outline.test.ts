import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBlock, searchBlocks, type BlockIndex, type BlockRead } from "../evidence/index.ts";
import { runFsOutline } from "./fs-outline.ts";

const codeSample = `import { readFile } from "node:fs/promises";

const LIMIT = 10;

export function alpha(input: string): string {
  const local = input.trim();
  return local;
}

export class Beta {
  run() {
    return 1;
  }
}

export interface Gamma {
  a: number;
}
`;

// 必须 async + await：同步 try/finally 会在 fn 的 await 完成前就把临时目录删掉。
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-outline-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("fs_outline exposes small code through the same complete source block", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "sample.ts");
    writeFileSync(file, codeSample);
    let saved: BlockIndex | undefined;
    const out = await runFsOutline({ path: file, reason: "看结构" }, (index) => { saved = index; });
    expect(out.ok).toBe(true);
    expect(saved).toBeDefined();
    expect(out.block).toEqual(readBlock(saved!, saved!.rootId));
    const block = out.block as BlockRead;
    expect(block.kind).toBe("content");
    if (block.kind === "content") {
      expect(block.content).toBe(codeSample);
      expect(block.source).toMatchObject({ path: file, startLine: 1 });
    }
  });
});

test("fs_outline text blocks use real source lines and immutable snapshots", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "notes.md");
    const text = "a".repeat(18000);
    writeFileSync(file, text);
    let saved: BlockIndex | undefined;
    const out = await runFsOutline({ path: file, reason: "看分块" }, (index) => { saved = index; });
    expect(out.ok).toBe(true);
    expect((out.block as BlockRead).kind).toBe("directory");
    writeFileSync(file, "changed after outline");
    const leaves = saved!.nodes.filter((node) => !node.children.length);
    expect(leaves.length).toBeGreaterThan(1);
    let reconstructed = "";
    for (const node of leaves) {
      const block = readBlock(saved!, node.id)!;
      if (block.kind === "content") {
        reconstructed += block.content;
        expect(block.source.startLine).toBe(1);
        expect(block.source.endLine).toBe(1);
      }
    }
    expect(reconstructed).toBe(text);
  });
});

test("fs_outline large code directories retrieve every complete function without truncated previews", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "big.ts");
    const body = Array.from({ length: 400 }, (_, i) => `export function fn${i}() {\n  return ${i};\n}\n`).join("\n");
    writeFileSync(file, body);
    let saved: BlockIndex | undefined;
    const out = await runFsOutline({ path: file, reason: "看结构" }, (index) => { saved = index; });
    expect(out.ok).toBe(true);
    expect((out.block as BlockRead).kind).toBe("directory");
    const hits = searchBlocks(saved!, "function fn399");
    expect(hits).toHaveLength(1);
    const block = readBlock(saved!, hits[0]!.blockId)!;
    expect(block.kind === "content" && block.content).toContain("export function fn399() {\n  return 399;\n}");
  });
});

test("fs_outline rejects directories and oversized files", async () => {
  await withTempDir(async (dir) => {
    const bad = await runFsOutline({ path: dir, reason: "非文件" });
    expect(bad.ok).toBe(false);
    const file = join(dir, "small.txt");
    writeFileSync(file, "hello");
    const tooBig = await runFsOutline({ path: file, maxFileBytes: 2, reason: "超限" });
    expect(tooBig.ok).toBe(false);
  });
});
