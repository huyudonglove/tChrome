import { errorInfo } from "../../shared/errors.ts";
import { lstat, readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import ts from "typescript";
import { runtimeConfig } from "../config/runtime.ts";
import { integer, pathArg } from "./local-files.ts";

/** 可给出符号表的代码扩展名。 */
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** 无结构化数据时的切块粒度占门禁的比例（4000 / 10 = 400 字符）。 */
const BLOCK_RATIO = 10;

type SymbolEntry = { kind: string; name: string; startLine: number; endLine: number };
type BlockEntry = { index: number; startLine: number; startOffset: number; chars: number; preview: string };

function kindOf(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isVariableStatement(node)) {
    const decls = node.declarationList.declarations;
    const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
    return isConst && decls.length === 1 ? "const" : "let";
  }
  return null;
}

function nameOf(node: ts.Node, source: ts.SourceFile): string {
  const named = node as ts.NamedDeclaration;
  if (named.name && named.name.text) return named.name.text;
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.map((d) => d.name.getText(source)).join(",");
  }
  return "";
}

/**
 * 只收顶层声明（source.statements）。实测下钻到函数体会灌入局部 const/let 噪音，
 * 条数放大 4-5 倍而信息量不增（admission.ts 14 → 68）。
 */
function collectSymbols(source: ts.SourceFile): SymbolEntry[] {
  const out: SymbolEntry[] = [];
  for (const node of source.statements) {
    const kind = kindOf(node);
    if (!kind) continue;
    const name = nameOf(node, source);
    if (!name) continue;
    const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    out.push({ kind, name, startLine: start, endLine: end });
  }
  return out;
}

/** 符号表装不下门禁时按 kind 折叠，保留可定位的行号区间。 */
function groupSymbols(symbols: SymbolEntry[], budget: number): { groups: Record<string, SymbolEntry[]> } | null {
  const rendered = symbols.map((s) => `${s.kind} ${s.name} ${s.startLine}-${s.endLine}`).join("\n");
  if (rendered.length <= budget) return null;
  const groups: Record<string, SymbolEntry[]> = {};
  for (const symbol of symbols) {
    (groups[symbol.kind] ??= []).push(symbol);
  }
  return { groups };
}

/**
 * 无结构化数据时的兜底：按固定字符数切块。
 * startOffset 为字符偏移，startLine 按 100 字折行口径换算（与 evidence.search 对齐）。
 */
function buildBlocks(text: string, lineWidth: number, blockChars: number): BlockEntry[] {
  const blocks: BlockEntry[] = [];
  const total = text.length;
  for (let offset = 0; offset < total; offset += blockChars) {
    const slice = text.slice(offset, offset + blockChars);
    const preview = slice.replace(/\s+/g, " ").trim().slice(0, 60);
    blocks.push({
      index: blocks.length,
      startOffset: offset,
      startLine: Math.floor(offset / lineWidth) + 1,
      chars: slice.length,
      preview,
    });
  }
  return blocks;
}

/** 提取文件大纲：代码文件出顶层符号表，无法结构化的按字符切块。 */
export async function runFsOutline(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const path = pathArg(input);
    const maxFileBytes = integer(input, "maxFileBytes", 1048576, 1, 1048576);
    const blockChars = integer(input, "blockChars", 0, 0, 1048576);
    const stat = await lstat(path);
    if (!stat.isFile()) throw new Error("path must be a regular file");
    if (stat.size > maxFileBytes) throw new Error(`file exceeds maxFileBytes (${stat.size} > ${maxFileBytes})`);
    const text = await readFile(path, "utf8");
    const ext = extname(path).toLowerCase();
    const totalLines = text.length ? text.split("\n").length : 0;
    const base = { ok: true, path, name: basename(path), bytes: stat.size, totalChars: text.length, totalLines };

    if (!CODE_EXT.has(ext)) {
      const gate = runtimeConfig.results.inlineChars;
      const size = blockChars > 0 ? blockChars : Math.max(100, Math.floor(gate / BLOCK_RATIO));
      return { ...base, mode: "blocks" as const, blockChars: size, blocks: buildBlocks(text, 100, size) };
    }

    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ext === ".tsx" || ext === ".jsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const symbols = collectSymbols(source);
    const grouped = groupSymbols(symbols, runtimeConfig.results.inlineChars);
    if (grouped) return { ...base, mode: "symbols" as const, symbolCount: symbols.length, grouped: grouped.groups };
    return { ...base, mode: "symbols" as const, symbolCount: symbols.length, symbols };
  } catch (error) {
    const { faultCode, detail, message } = errorInfo(error, "tool_execution_failed");
    return { ok: false, path: typeof input.path === "string" ? input.path : undefined, faultCode, error: detail || message };
  }
}
