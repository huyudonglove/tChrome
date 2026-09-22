import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";

export interface SymbolDef {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "variable" | "other";
  signature?: string;
  line: number;
}

export interface FileSymbols {
  relativePath: string;
  symbols: SymbolDef[];
  imports: string[];
  referenceCount?: number;
}

export interface RepoMapOptions {
  includeExtensions?: string[];
  excludePatterns?: string[];
  maxLines?: number;
  verboseSignatures?: boolean;
}

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const DEFAULT_EXCLUDES = [
  "node_modules",
  "dist",
  ".git",
  ".next",
  "coverage",
  "process-output",
  "returns",
  "turns",
];

/**
 * 递归扫描目录获取所有源代码文件
 */
export function scanSourceFiles(dir: string, options: RepoMapOptions = {}): string[] {
  const exts = new Set(options.includeExtensions || DEFAULT_EXTENSIONS);
  const excludes = new Set(options.excludePatterns || DEFAULT_EXCLUDES);

  const results: string[] = [];

  function walk(currentDir: string) {
    let entries: string[] = [];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (excludes.has(entry) || entry.startsWith(".")) {
        if (entry !== ".env.example") continue;
      }

      const fullPath = join(currentDir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        const ext = extname(entry);
        if (exts.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * 从单个文件源码中提取顶级符号（函数、类、接口、类型、变量）与导入依赖
 */
export function extractSymbolsFromFile(content: string, relativePath: string): FileSymbols {
  const symbols: SymbolDef[] = [];
  const imports: string[] = [];

  const lines = content.split("\n");

  // 正则规则覆盖常见 TypeScript/JavaScript 顶级与导出声明
  const importRegex = /import\s+(?:(?:type\s+)?[\w*\s{},]+from\s+)?['"]([^'"]+)['"]/;
  const funcRegex = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*(<[^>]+>)?\s*\(([^)]*)\)(?::\s*([^{]+))?/;
  const classRegex = /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/;
  const interfaceRegex = /^(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/;
  const typeRegex = /^(?:export\s+)?type\s+([A-Za-z0-9_$]+)/;
  const constFuncRegex = /^(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*(?::\s*([^{=>]+))?\s*=>/;
  const varRegex = /^(?:export\s+)(?:const|let|var)\s+([A-Za-z0-9_$]+)(?::\s*([^=;]+))?/;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    const lineNum = i + 1;

    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      continue;
    }

    // 提取 imports
    const importMatch = trimmed.match(importRegex);
    if (importMatch && importMatch[1]) {
      imports.push(importMatch[1]);
      continue;
    }

    // 1. 函数声明
    const funcMatch = trimmed.match(funcRegex);
    if (funcMatch) {
      const name = funcMatch[1];
      const params = funcMatch[3] ? funcMatch[3].trim() : "";
      const returnType = funcMatch[4] ? funcMatch[4].trim() : "";
      const sig = returnType ? `(${params}): ${returnType}` : `(${params})`;
      symbols.push({ name, kind: "function", signature: sig, line: lineNum });
      continue;
    }

    // 2. 箭头函数变量
    const constFuncMatch = trimmed.match(constFuncRegex);
    if (constFuncMatch) {
      const name = constFuncMatch[1];
      const params = constFuncMatch[2] ? constFuncMatch[2].trim() : "";
      const returnType = constFuncMatch[3] ? constFuncMatch[3].trim() : "";
      const sig = returnType ? `(${params}): ${returnType}` : `(${params})`;
      symbols.push({ name, kind: "function", signature: sig, line: lineNum });
      continue;
    }

    // 3. 类声明
    const classMatch = trimmed.match(classRegex);
    if (classMatch) {
      symbols.push({ name: classMatch[1], kind: "class", line: lineNum });
      continue;
    }

    // 4. 接口声明
    const interfaceMatch = trimmed.match(interfaceRegex);
    if (interfaceMatch) {
      symbols.push({ name: interfaceMatch[1], kind: "interface", line: lineNum });
      continue;
    }

    // 5. 类型声明
    const typeMatch = trimmed.match(typeRegex);
    if (typeMatch) {
      symbols.push({ name: typeMatch[1], kind: "type", line: lineNum });
      continue;
    }

    // 6. 普通导出变量
    const varMatch = trimmed.match(varRegex);
    if (varMatch && !trimmed.includes("=>")) {
      const name = varMatch[1];
      const type = varMatch[2] ? varMatch[2].trim() : "";
      symbols.push({ name, kind: "variable", signature: type || undefined, line: lineNum });
      continue;
    }
  }

  return { relativePath, symbols, imports };
}

/**
 * 构建全工程符号拓扑索引与紧凑渲染文本
 */
export function buildRepoMap(repoRoot: string, options: RepoMapOptions = {}): {
  files: FileSymbols[];
  totalFiles: number;
  totalSymbols: number;
  renderedMap: string;
} {
  const sourceFiles = scanSourceFiles(repoRoot, options);
  const fileSymbolList: FileSymbols[] = [];

  // 符号引用频度计数（简易拓扑重要性打分）
  const importOccurrences = new Map<string, number>();

  for (const file of sourceFiles) {
    const rel = relative(repoRoot, file);
    let content = "";
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const info = extractSymbolsFromFile(content, rel);
    fileSymbolList.push(info);

    for (const imp of info.imports) {
      // 累加引用计数
      const base = imp.split("/").pop() || imp;
      importOccurrences.set(base, (importOccurrences.get(base) || 0) + 1);
    }
  }

  // 计算权重并按依赖热度排序
  for (const info of fileSymbolList) {
    const fileName = info.relativePath.split("/").pop()?.replace(/\.[^.]+$/, "") || "";
    info.referenceCount = importOccurrences.get(fileName) || 0;
  }

  // 排序：先按目录结构，再按重要性
  fileSymbolList.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  let totalSymbols = 0;
  const lines: string[] = ["# Project Repository Symbol Map (AST Topo)"];

  for (const file of fileSymbolList) {
    if (file.symbols.length === 0) continue;
    totalSymbols += file.symbols.length;

    lines.push(`\n${file.relativePath}:`);
    for (const sym of file.symbols) {
      let desc = `  - ${sym.kind} ${sym.name}`;
      if (options.verboseSignatures !== false && sym.signature) {
        desc += sym.signature.startsWith("(") ? sym.signature : `: ${sym.signature}`;
      }
      lines.push(desc);
    }

    if (options.maxLines && lines.length >= options.maxLines) {
      lines.push("\n... [truncated for token budget]");
      break;
    }
  }

  return {
    files: fileSymbolList,
    totalFiles: fileSymbolList.length,
    totalSymbols,
    renderedMap: lines.join("\n"),
  };
}
