import { existsSync, statSync } from "node:fs";
import { buildRepoMap, type RepoMapOptions, type FileSymbols } from "../runtime/repo-map.ts";

export const LOCAL_REPO_MAP_TOOL_NAMES = ["local.repo_map"] as const;

const DEFAULTS = {
  depth: 2,
  maxDirs: 60,
  symbolsPerDir: 6,
  maxLines: 400,
} as const;

/** 出现在文件顶部的声明类型，作为「这个文件负责什么」的线索 */
const ENTRY_KINDS = new Set(["function", "class", "interface", "type"]);

function textOf(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function intOf(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return undefined;
}

function stringListOf(input: Record<string, unknown>, key: string): string[] | undefined {
  const value = input[key];
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return list.length ? list : undefined;
}

/** 取路径前 depth 段作为聚合目录名 */
function dirOf(relativePath: string, depth: number): string {
  const parts = relativePath.split("/").filter(Boolean);
  if (parts.length <= 1) return ".";
  return parts.slice(0, Math.min(depth, parts.length - 1)).join("/");
}

/** 入口文件优先：符号多、被引用多；主要符号优先 entry 类型的声明 */
function pickSymbols(file: FileSymbols, limit: number): string[] {
  const ranked = [...file.symbols].sort((a, b) => {
    const rank = (kind: string) => (ENTRY_KINDS.has(kind) ? 0 : 1);
    return rank(a.kind) - rank(b.kind) || a.line - b.line;
  });
  return ranked.slice(0, Math.max(0, limit)).map((sym) => `${sym.kind} ${sym.name}`);
}

function aggregate(files: FileSymbols[], depth: number, maxDirs: number, symbolsPerDir: number) {
  const buckets = new Map<string, FileSymbols[]>();
  for (const file of files) {
    if (file.symbols.length === 0) continue;
    const dir = dirOf(file.relativePath, depth);
    const bucket = buckets.get(dir);
    if (bucket) bucket.push(file);
    else buckets.set(dir, [file]);
  }

  const directories = [...buckets.entries()]
    .map(([dir, dirFiles]) => {
      const topFiles = [...dirFiles]
        .sort((a, b) => (b.referenceCount ?? 0) - (a.referenceCount ?? 0) || b.symbols.length - a.symbols.length)
        .slice(0, 3)
        .map((file) => ({
          path: file.relativePath,
          referenceCount: file.referenceCount ?? 0,
          symbols: pickSymbols(file, symbolsPerDir),
        }));
      return {
        dir,
        files: dirFiles.length,
        symbols: dirFiles.reduce((sum, file) => sum + file.symbols.length, 0),
        topFiles,
      };
    })
    .sort((a, b) => b.symbols - a.symbols || a.dir.localeCompare(b.dir));

  return { directories, totalDirs: directories.length, truncated: directories.length > maxDirs, directoriesKept: Math.min(directories.length, maxDirs) };
}

export async function runRepoMap(input: Record<string, unknown>) {
  const path = textOf(input, "path");
  if (!path) return { ok: false, error: "缺少 path：仓库或目录的绝对路径。" };

  const mode = textOf(input, "mode") === "map" ? "map" : "directories";
  const depth = intOf(input, "depth") ?? DEFAULTS.depth;
  const maxDirs = intOf(input, "maxDirs") ?? DEFAULTS.maxDirs;
  const symbolsPerDir = intOf(input, "symbolsPerDir") ?? DEFAULTS.symbolsPerDir;
  const includeExtensions = stringListOf(input, "includeExtensions");
  const excludePatterns = stringListOf(input, "excludePatterns");
  const maxLines = intOf(input, "maxLines") ?? DEFAULTS.maxLines;
  const verboseSignatures = input["verboseSignatures"] === true;

  if (!existsSync(path) || !statSync(path).isDirectory()) {
    return {
      ok: false,
      path,
      error: `路径不存在或不是目录：${path}`,
      ...(mode === "map" ? { note: "path 必须是仓库或目录的绝对路径；单个文件请改用 local.fs_outline。" } : {}),
    };
  }

  const options: RepoMapOptions = {
    ...(includeExtensions ? { includeExtensions } : {}),
    ...(excludePatterns ? { excludePatterns } : {}),
    ...(mode === "map" ? { maxLines, verboseSignatures } : {}),
  };

  let built: ReturnType<typeof buildRepoMap>;
  try {
    built = buildRepoMap(path, options);
  } catch (error) {
    return {
      ok: false,
      path,
      error: `扫描失败：${error instanceof Error ? error.message : String(error)}`,
      ...(mode === "map" ? { note: "确认 path 是存在的目录；单文件请改用 local.fs_outline。" } : {}),
    };
  }

  const totals = { files: built.totalFiles, symbols: built.totalSymbols };

  if (mode === "map") {
    return { ok: true, path, mode, totals, renderedMap: built.renderedMap };
  }

  const { directories, totalDirs, truncated, directoriesKept } = aggregate(built.files, depth, maxDirs, symbolsPerDir);
  return {
    ok: built.totalFiles > 0,
    path,
    mode,
    depth,
    totals,
    directories: directories.slice(0, maxDirs),
    totalDirs,
    ...(truncated ? { truncated: true, note: `目录数超过 maxDirs=${maxDirs}，已按符号数降序截断；缩小 path 或调大 maxDirs 可看全。` } : {}),
    ...(directoriesKept === 0
      ? { note: "该路径下没扫到带符号的源文件 —— 可能是空目录、全是测试/资源文件，或代码用了本工具不识别的扩展名。" }
      : {}),
  };
}