import { errorInfo } from "../../shared/errors.ts";
import { constants } from "node:fs";
import { cp, lstat, mkdir, open, opendir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

export const LOCAL_FILE_TOOL_NAMES = [
  "local_fs_list", "local_fs_stat", "local_fs_read", "local_fs_write", "local_fs_mkdir",
  "local_fs_copy", "local_fs_move", "local_fs_delete", "local_fs_search", "local_fs_grep", "local_replace_block",
] as const;

const SECRET_FILE = /^\.env(\..*)?$|\.(key|pem|p12|pfx)$/i;
/** Env files and key material are skipped by default so plaintext secrets stay out of the model context. */
function isSecretFile(name: string) {
  return SECRET_FILE.test(name);
}

export function pathArg(input: Record<string, unknown>, key = "path") {
  const value = input[key];
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${key} must be an absolute path`);
  }
  return resolve(value);
}
export function integer(input: Record<string, unknown>, key: string, fallback: number, min: number, max: number) {
  const value = input[key] ?? fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}
function flag(input: Record<string, unknown>, key: string) {
  if (input[key] !== undefined && typeof input[key] !== "boolean") throw new Error(`${key} must be boolean`);
  return input[key] === true;
}
function typeOf(value: { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }) {
  return value.isSymbolicLink() ? "symlink" : value.isDirectory() ? "directory" : value.isFile() ? "file" : "other";
}
function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
const stripExt = (name: string) => name.replace(/\.[^.]+$/, "");
/** On ENOENT, look a few levels up for entries resembling the missing basename. */
async function nearestPathCandidates(path: string): Promise<string[]> {
  const segments = path.split(sep).filter(Boolean);
  const base = segments[segments.length - 1] ?? "";
  if (!base) return [];
  const scored: { candidate: string; score: number }[] = [];
  for (let cut = 1; cut <= 3 && cut < segments.length; cut++) {
    const parent = sep + segments.slice(0, segments.length - cut).join(sep);
    let entries: string[];
    try {
      entries = await readdir(parent);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const score = Math.max(commonPrefixLength(entry, base), commonPrefixLength(stripExt(entry), stripExt(base)));
      if (score >= 3) scored.push({ candidate: join(parent, entry), score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return [...new Set(scored.map((item) => item.candidate))].slice(0, 3);
}
/** Attach nearest-existing-path candidates to a failed result so callers can self-correct without guessing. */
async function withCandidates<T extends Record<string, unknown>>(result: T, path: unknown): Promise<T> {
  if (result.faultCode !== "file_not_found" || typeof path !== "string" || !path) return result;
  const candidates = await nearestPathCandidates(path);
  return candidates.length ? { ...result, candidates } : result;
}

async function searchOneDir(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const path = pathArg(input);
    if (typeof input.query !== "string" || !input.query.length) throw new Error("query must be a non-empty filename substring");
    const limit = integer(input, "limit", 100, 1, 1000);
    const maxEntries = integer(input, "maxEntries", 10000, 1, 100000);
    if (!(await lstat(path)).isDirectory()) throw new Error("path must be a directory, not a file or symlink; pass the containing directory, or use local_fs_stat/local_fs_read for a file path");
    const pending = [path];
    const matches: Record<string, unknown>[] = [];
    let scanned = 0;
    let truncated = false;
    const errors: { path: string; error: string }[] = [];
    outer: while (pending.length) {
      const directory = pending.pop()!;
      try {
        for await (const entry of await opendir(directory)) {
          if (scanned >= maxEntries || matches.length >= limit) { truncated = true; break outer; }
          scanned++;
          const entryPath = join(directory, entry.name);
          if (entry.name.includes(input.query)) matches.push({ path: entryPath, name: entry.name, type: typeOf(entry) });
          if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(entryPath);
        }
      } catch (error) {
        if (directory === path) throw error;
        if (errors.length < 100) errors.push({ path: directory, error: error instanceof Error ? error.message : String(error) });
        truncated = true;
      }
    }
    return { ok: true, path, matches, scanned, truncated, errors };
  } catch (error) {
    const { faultCode, detail } = errorInfo(error, "tool_execution_failed");
    return withCandidates({ ok: false, path: typeof input.path === "string" ? input.path : undefined, faultCode, error: detail }, input.path);
  }
}

async function readOneFile(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const path = pathArg(input);
    if (input.startLine !== undefined) {
      if (input.offset !== undefined) {
        throw new Error("cannot specify both offset and startLine");
      }
      const startLine = integer(input, "startLine", 1, 1, Number.MAX_SAFE_INTEGER);
      const stat = await lstat(path);
      if (!stat.isFile()) throw new Error("path must be a regular file");
      const text = await readFile(path, "utf8");
      const allLines = text.split("\n");
      const totalLines = allLines.length;
      let endLine: number | undefined;
      if (input.endLine !== undefined) {
        endLine = integer(input, "endLine", totalLines, 1, Number.MAX_SAFE_INTEGER);
        if (endLine < startLine) {
          throw new Error("endLine must be greater than or equal to startLine");
        }
      }
      if (startLine > totalLines) {
        return { ok: true, path, content: "", startLine, endLine, totalLines };
      }
      const effectiveEnd = endLine !== undefined ? Math.min(endLine, totalLines) : totalLines;
      const content = allLines.slice(startLine - 1, effectiveEnd).join("\n");
      return { ok: true, path, content, startLine, endLine: effectiveEnd, totalLines };
    }
    const offset = integer(input, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = integer(input, "limit", 65536, 4, 1048576);
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("path must be a regular file");
      const buffer = Buffer.alloc(limit + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      let consumed = Math.min(bytesRead, limit);
      // Keep complete UTF-8 characters when the next page starts at nextOffset.
      if (bytesRead > limit) {
        while (consumed > 0 && (buffer[consumed]! & 0xc0) === 0x80) consumed--;
        if (consumed === 0) consumed = limit; // Invalid UTF-8 must still make progress.
      }
      return { ok: true, path, content: buffer.subarray(0, consumed).toString("utf8"), offset, nextOffset: offset + consumed, size: stat.size, truncated: offset + consumed < stat.size };
    } finally { await file.close(); }
  } catch (error) {
    const { faultCode, detail } = errorInfo(error, "tool_execution_failed");
    return withCandidates({ ok: false, faultCode, error: detail }, input.path);
  }
}

export async function runLocalFileTool(name: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  try {
    if (name === "local_fs_read") {
      const items = input.items;
      if (!Array.isArray(items) || items.length < 1 || items.length > 8) {
        throw new Error("items must be an array of 1..8 {path, offset?, limit?, startLine?, endLine?}");
      }
      const results = await Promise.all(items.map((item) => {
        const row = (item ?? {}) as Record<string, unknown>;
        return readOneFile(row);
      }));
      const ok = results.every((row) => row.ok);
      // Opt-in total content budget: keep the return inside the inline gate by
      // cutting whole lines in item order, instead of letting Runtime externalize
      // the whole batch into a pointer. Never applied unless the caller asks.
      if (input.maxChars !== undefined) {
        const maxChars = integer(input, "maxChars", 0, 200, 1000000);
        const total = results.reduce((sum, row) => sum + (typeof row.content === "string" ? row.content.length : 0), 0);
        if (total > maxChars) {
          let remaining = maxChars;
          // Track who was cut and how hard: a fully emptied item is unreadable in the
          // return, so the note has to name it instead of leaving the caller guessing.
          const fullyCut: string[] = [];
          const partiallyCut: string[] = [];
          for (const row of results) {
            if (typeof row.content !== "string" || row.content.length === 0) continue;
            if (remaining <= 0) {
              row.content = "";
              row.truncatedForBudget = true;
              fullyCut.push(row.path);
              continue;
            }
            if (row.content.length <= remaining) {
              remaining -= row.content.length;
              continue;
            }
            const kept: string[] = [];
            let used = 0;
            for (const line of row.content.split("\n")) {
              const cost = line.length + 1;
              if (used + cost > remaining) break;
              kept.push(line);
              used += cost;
            }
            row.content = kept.join("\n");
            row.truncatedForBudget = true;
            partiallyCut.push(row.path);
            remaining -= used;
          }
          const who = fullyCut.length > 0 ? ` fully cut (content came back empty): ${fullyCut.join(", ")};` : "";
          const partial = partiallyCut.length > 0 ? ` partially cut: ${partiallyCut.join(", ")};` : "";
          return { ok, results, budgetNote: `total content ${total} chars exceeded maxChars=${maxChars}; items were cut in order at line boundaries —${who}${partial} re-read the named ones with a precise startLine/endLine` };
        }
      }
      return { ok, results };
    }
    if (name === "local_fs_search") {
      const items = input.items;
      if (!Array.isArray(items) || items.length < 1 || items.length > 8) {
        throw new Error("items must be an array of 1..8 {path, query, limit?, maxEntries?}");
      }
      const results = await Promise.all(items.map((item) => {
        const row = (item ?? {}) as Record<string, unknown>;
        return searchOneDir(row);
      }));
      return { ok: results.every((row) => row.ok), results };
    }
    if (name === "local_fs_copy" || name === "local_fs_move") {
      const source = pathArg(input, "source");
      const destination = pathArg(input, "destination");
      const overwrite = flag(input, "overwrite");
      if (destination === source || destination.startsWith(source + sep)) throw new Error("destination must differ from source and cannot be inside it");
      if (!overwrite) {
        try {
          await lstat(destination);
          throw new Error("destination already exists; set overwrite explicitly to replace it");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (name === "local_fs_move" && overwrite) {
        await rename(source, destination);
      } else {
        // cp's exclusive mode also protects against destinations created after validation.
        await cp(source, destination, { recursive: true, force: overwrite, errorOnExist: !overwrite, dereference: false, verbatimSymlinks: true });
        if (name === "local_fs_move") await rm(source, { recursive: true });
      }
      return { ok: true, source, destination };
    }
    const path = pathArg(input);
    switch (name) {
      case "local_fs_stat": {
        const stat = await lstat(path);
        return { ok: true, path, type: typeOf(stat), size: stat.size, modifiedAt: stat.mtime.toISOString(), mode: stat.mode };
      }
      case "local_fs_list": {
        const limit = integer(input, "limit", 200, 1, 1000);
        const entries: Record<string, unknown>[] = [];
        let truncated = false;
        if (!(await lstat(path)).isDirectory()) {
          throw new Error("path must be a directory, not a file or symlink; pass the containing directory, or use local_fs_stat/local_fs_read for a file path");
        }
        for await (const entry of await opendir(path)) {
          if (entries.length >= limit) { truncated = true; break; }
          entries.push({ name: entry.name, path: join(path, entry.name), type: typeOf(entry) });
        }
        return { ok: true, path, entries, truncated };
      }
      case "local_replace_block": {
        if (typeof input.search !== "string" || !input.search.length) throw new Error("search must be a non-empty string");
        if (typeof input.replace !== "string") throw new Error("replace must be a string");
        const expectedMatches = integer(input, "expectedMatches", 1, 1, 1000);
        const stat = await lstat(path);
        if (!stat.isFile()) throw new Error("path must be a regular file");
        const original = await readFile(path, "utf8");
        let count = 0;
        let pos = 0;
        while ((pos = original.indexOf(input.search, pos)) !== -1) {
          count++;
          pos += input.search.length;
        }
        if (count !== expectedMatches) {
          throw new Error(`Expected ${expectedMatches} match(es) for search block, but found ${count}`);
        }
        const updated = original.split(input.search).join(input.replace);
        await writeFile(path, updated, "utf8");
        return { ok: true, path, matches: count, bytesWritten: Buffer.byteLength(updated) };
      }
      case "local_fs_write": {
        if (typeof input.content !== "string") throw new Error("content must be a string");
        const append = flag(input, "append");
        await mkdir(resolve(path, ".."), { recursive: true });
        const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NONBLOCK | (append ? constants.O_APPEND : 0));
        try {
          if (!(await file.stat()).isFile()) throw new Error("path must be a regular file");
          if (!append) await file.truncate(0);
          await file.writeFile(input.content, "utf8");
        } finally { await file.close(); }
        return { ok: true, path, bytesWritten: Buffer.byteLength(input.content), append };
      }
      case "local_fs_mkdir":
        await mkdir(path, { recursive: flag(input, "recursive") });
        return { ok: true, path };
      case "local_fs_delete":
        if (path === resolve(path, "..")) throw new Error("cannot delete filesystem root");
        await rm(path, { recursive: flag(input, "recursive"), force: false });
        return { ok: true, path };
      case "local_fs_grep": {
        if (typeof input.query !== "string" || !input.query.length || input.query.length > 500) {
          throw new Error("query must be a literal substring or regex of 1 to 500 characters");
        }
        const query = input.query;
        const useRegex = flag(input, "regex");
        // m 标志：整文件文本一次性喂给 exec，没有 m 时 ^/$ 只锚定整文件首尾，行首/行尾锚点必然落空
        const pattern = useRegex ? new RegExp(query, "gm") : null;
        const limit = integer(input, "limit", 50, 1, 200);
        const maxFiles = integer(input, "maxFiles", 5000, 1, 5000);
        const maxFileBytes = integer(input, "maxFileBytes", 1048576, 1, 1048576);
        const maxEntries = integer(input, "maxEntries", 10000, 1, 100000);
        const contextChars = integer(input, "contextChars", 80, 0, 200);
        const contextLines = integer(input, "contextLines", 0, 0, 20);
        const rootStat = await lstat(path);
        const singleFile = rootStat.isFile() ? path : null;
        if (!singleFile && !rootStat.isDirectory()) throw new Error("path must be a directory or a regular file, not a symlink or special file; pass the containing directory to search a whole tree, or a single file path to search only that file");
        const pending = [singleFile ? resolve(path, "..") : path];
        const matches: Record<string, unknown>[] = [];
        let scannedFiles = 0;
        let scannedEntries = 0;
        let truncated = false;
        const truncations: string[] = [];
        const skipped: { path: string; reason: string }[] = [];
        const errors: { path: string; error: string }[] = [];
        const skipDirs = new Set(["node_modules", ".git"]);
        outer: while (pending.length) {
          const directory = pending.pop()!;
          try {
            for await (const entry of await opendir(directory)) {
              if (scannedEntries >= maxEntries || matches.length >= limit) {
                truncations.push(scannedEntries >= maxEntries ? "maxEntries" : "limit");
                truncated = true;
                break outer;
              }
              scannedEntries++;
              const entryPath = join(directory, entry.name);
              if (singleFile && entryPath !== singleFile) continue;
              if (entry.isSymbolicLink()) continue;
              if (entry.isDirectory()) {
                if (skipDirs.has(entry.name)) {
                  if (skipped.length < 100) skipped.push({ path: entryPath, reason: "skipped directory" });
                  continue;
                }
                pending.push(entryPath);
                continue;
              }
              if (!entry.isFile()) continue;
              if (!singleFile && isSecretFile(entry.name)) {
                if (skipped.length < 100) skipped.push({ path: entryPath, reason: "secret file" });
                continue;
              }
              if (scannedFiles >= maxFiles) { truncations.push("maxFiles"); truncated = true; break outer; }
              scannedFiles++;
              const stat = await lstat(entryPath);
              if (!stat.isFile()) continue;
              if (stat.size > maxFileBytes) {
                if (skipped.length < 100) skipped.push({ path: entryPath, reason: "file exceeds maxFileBytes" });
                continue;
              }
              const bytes = await readFile(entryPath);
              if (bytes.includes(0)) {
                if (skipped.length < 100) skipped.push({ path: entryPath, reason: "binary" });
                continue;
              }
              const text = bytes.toString("utf8");
              let lines: string[] | null = null;
              const linesOf = () => (lines ??= text.split("\n"));
              const pushMatch = (at: number, hit: string) => {
                const lineStart = text.lastIndexOf("\n", at - 1) + 1;
                const lineEnd = text.indexOf("\n", at);
                const lineText = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
                const column = at - lineStart + 1;
                const line = text.slice(0, at).split("\n").length;
                const row: Record<string, unknown> = {
                  path: entryPath,
                  line,
                  column,
                  before: lineText.slice(Math.max(0, column - 1 - contextChars), column - 1),
                  hit,
                  after: lineText.slice(column - 1 + hit.length, column - 1 + hit.length + contextChars),
                };
                if (contextLines > 0) {
                  const all = linesOf();
                  row.beforeLines = all.slice(Math.max(0, line - 1 - contextLines), line - 1);
                  row.afterLines = all.slice(line, line + contextLines);
                }
                matches.push(row);
              };
              if (pattern) {
                pattern.lastIndex = 0;
                while (matches.length < limit) {
                  const m = pattern.exec(text);
                  if (!m) break;
                  pushMatch(m.index, m[0]);
                  pattern.lastIndex = m.index + Math.max(m[0].length, 1);
                  if (matches.length >= limit) { truncations.push("limit"); truncated = true; break outer; }
                }
              } else {
                let from = 0;
                while (matches.length < limit) {
                  const at = text.indexOf(query, from);
                  if (at === -1) break;
                  pushMatch(at, query);
                  from = at + Math.max(query.length, 1);
                  if (matches.length >= limit) { truncations.push("limit"); truncated = true; break outer; }
                }
              }
            }
          } catch (error) {
            if (directory === path || (singleFile && directory === resolve(path, ".."))) throw error;
            if (errors.length < 100) errors.push({ path: directory, error: error instanceof Error ? error.message : String(error) });
            truncations.push("error");
            truncated = true;
          }
        }
        const base = { ok: true, path, matches, scannedFiles, scannedEntries, truncated, truncations, partial: truncated, errors };
        if (matches.length) return { ...base, skipped };
        return {
          ...base,
          skippedCount: skipped.length,
          note: truncated
            ? `no matches, but the search stopped early (${truncations.join(", ")}); 0 matches does not mean the whole tree is clean`
            : "no matches in the whole scanned tree",
        };
      }
      default: throw new Error(`Unknown local file tool: ${name}`);
    }
  } catch (error) {
    return withCandidates({ ok: false, ...errorInfo(error), error: error instanceof Error ? error.message : String(error) }, input.path);
  }
}
