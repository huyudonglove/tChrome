import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractSymbolsFromFile,
  scanSourceFiles,
  buildRepoMap,
} from "./repo-map.ts";

describe("repo-map: 工程级轻量符号拓扑索引器", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "repo-map-test-"));
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("1. extractSymbolsFromFile: 精准提取函数、类、接口、类型与变量定义", () => {
    const code = `
import { foo } from "./other.ts";
import type { Bar } from "./types.ts";

export interface UserConfig {
  id: string;
  name: string;
}

export type Status = "idle" | "running";

export async function processTask<T>(id: string, options?: UserConfig): Promise<boolean> {
  return true;
}

export class TaskRunner {
  run() {}
}

export const helperFn = (x: number): number => x * 2;
export const MAX_RETRY: number = 3;
`;

    const info = extractSymbolsFromFile(code, "test/sample.ts");

    expect(info.relativePath).toBe("test/sample.ts");
    expect(info.imports).toContain("./other.ts");
    expect(info.imports).toContain("./types.ts");

    const symbolNames = info.symbols.map((s) => s.name);
    expect(symbolNames).toContain("UserConfig");
    expect(symbolNames).toContain("Status");
    expect(symbolNames).toContain("processTask");
    expect(symbolNames).toContain("TaskRunner");
    expect(symbolNames).toContain("helperFn");
    expect(symbolNames).toContain("MAX_RETRY");

    // 检查符号分类与签名
    const userConfig = info.symbols.find((s) => s.name === "UserConfig");
    expect(userConfig?.kind).toBe("interface");

    const processTask = info.symbols.find((s) => s.name === "processTask");
    expect(processTask?.kind).toBe("function");
    expect(processTask?.signature).toContain("Promise<boolean>");

    const taskRunner = info.symbols.find((s) => s.name === "TaskRunner");
    expect(taskRunner?.kind).toBe("class");

    const helper = info.symbols.find((s) => s.name === "helperFn");
    expect(helper?.kind).toBe("function");
  });

  test("2. scanSourceFiles: 递归扫描源文件并正确跳过 node_modules 与隐藏目录", () => {
    mkdirSync(join(testDir, "src"), { recursive: true });
    mkdirSync(join(testDir, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(testDir, ".git"), { recursive: true });

    writeFileSync(join(testDir, "src", "index.ts"), "export const a = 1;");
    writeFileSync(join(testDir, "src", "app.tsx"), "export const App = () => null;");
    writeFileSync(join(testDir, "node_modules", "pkg", "index.js"), "export const dummy = 0;");
    writeFileSync(join(testDir, ".git", "config.js"), "ignore me");

    const files = scanSourceFiles(testDir);
    const fileNames = files.map((f) => f.replace(testDir + "/", ""));

    expect(fileNames).toContain("src/index.ts");
    expect(fileNames).toContain("src/app.tsx");
    expect(fileNames.some((f) => f.includes("node_modules"))).toBe(false);
    expect(fileNames.some((f) => f.includes(".git"))).toBe(false);
  });

  test("3. buildRepoMap: 拓扑关联与紧凑符号图渲染（Aider Repo Map 核心）", () => {
    mkdirSync(join(testDir, "core"), { recursive: true });
    mkdirSync(join(testDir, "utils"), { recursive: true });

    writeFileSync(
      join(testDir, "utils", "math.ts"),
      "export function add(a: number, b: number): number { return a + b; }\nexport const PI = 3.14;"
    );

    writeFileSync(
      join(testDir, "core", "service.ts"),
      "import { add } from '../utils/math.ts';\nexport class WorkerService {\n  execute() {}\n}"
    );

    const result = buildRepoMap(testDir);

    expect(result.totalFiles).toBe(2);
    expect(result.totalSymbols).toBe(3);
    expect(result.renderedMap).toContain("# Project Repository Symbol Map (AST Topo)");
    expect(result.renderedMap).toContain("core/service.ts:");
    expect(result.renderedMap).toContain("- class WorkerService");
    expect(result.renderedMap).toContain("utils/math.ts:");
    expect(result.renderedMap).toContain("- function add(a: number, b: number): number");
  });
});
