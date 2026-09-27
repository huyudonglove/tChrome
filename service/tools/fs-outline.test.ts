import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("fs_outline returns top-level symbols with line ranges for code files", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "sample.ts");
    writeFileSync(file, codeSample);
    const out = await runFsOutline({ path: file, reason: "看结构" });
    expect(out.ok).toBe(true);
    expect(out.mode).toBe("symbols");
    const names = (out.symbols as { kind: string; name: string; startLine: number; endLine: number }[]).map((s) => s.name);
    expect(names).toContain("alpha");
    expect(names).toContain("Beta");
    expect(names).toContain("Gamma");
    // 函数体内的局部变量不应进入顶层符号表
    expect(names).not.toContain("local");
    const alpha = (out.symbols as { name: string; startLine: number }[]).find((s) => s.name === "alpha");
    expect(alpha?.startLine).toBe(5);
  });
});

test("fs_outline chunks unstructured files by blockChars", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "notes.md");
    writeFileSync(file, "a".repeat(1000));
    const out = await runFsOutline({ path: file, blockChars: 400, reason: "看分块" });
    expect(out.ok).toBe(true);
    expect(out.mode).toBe("blocks");
    expect(out.blockChars).toBe(400);
    const blocks = out.blocks as { index: number; startOffset: number; startLine: number; chars: number }[];
    expect(blocks.length).toBe(3);
    expect(blocks[0].startOffset).toBe(0);
    expect(blocks[0].startLine).toBe(1);
    expect(blocks[1].startOffset).toBe(400);
    expect(blocks[1].startLine).toBe(5);
  });
});

test("fs_outline groups symbols by kind when the table exceeds the inline budget", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "big.ts");
    const body = Array.from({ length: 400 }, (_, i) => `export function fn${i}() {\n  return ${i};\n}\n`).join("\n");
    writeFileSync(file, body);
    const out = await runFsOutline({ path: file, reason: "看结构" });
    expect(out.ok).toBe(true);
    expect(out.mode).toBe("symbols");
    expect(out.symbols).toBeUndefined();
    const grouped = out.grouped as Record<string, { name: string }[]>;
    expect(Array.isArray(grouped.function)).toBe(true);
    expect(grouped.function.length).toBe(400);
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
