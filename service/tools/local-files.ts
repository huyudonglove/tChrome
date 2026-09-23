import { errorInfo } from "../../shared/errors.ts";
import { constants } from "node:fs";
import { cp, lstat, mkdir, open, opendir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

export const LOCAL_FILE_TOOL_NAMES = [
  "local.fs_list", "local.fs_stat", "local.fs_read", "local.fs_write", "local.fs_mkdir",
  "local.fs_copy", "local.fs_move", "local.fs_delete", "local.fs_search", "local.fs_grep", "local.replace_block",
] as const;

function pathArg(input: Record<string, unknown>, key = "path") {
  const value = input[key];
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${key} must be an absolute path`);
  }
  return resolve(value);
}
function integer(input: Record<string, unknown>, key: string, fallback: number, min: number, max: number) {
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

async function readOneFile(rawPath: unknown, rawOffset: unknown, rawLimit: unknown): Promise<Record<string, unknown>> {
  try {
    const path = pathArg({ path: rawPath });
    const offset = integer({ offset: rawOffset }, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = integer({ limit: rawLimit }, "limit", 65536, 4, 1048576);
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
    const { faultCode, detail, message } = errorInfo(error, "tool_execution_failed");
    return { ok: false, faultCode, error: detail || message };
  }
}

export async function runLocalFileTool(name: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  try {
    if (name === "local.fs_read") {
      const items = input.items;
      if (!Array.isArray(items) || items.length < 1 || items.length > 8) {
        throw new Error("items must be an array of 1..8 {path, offset?, limit?}");
      }
      const results = await Promise.all(items.map((item) => {
        const row = (item ?? {}) as Record<string, unknown>;
        return readOneFile(row.path, row.offset, row.limit);
      }));
      return { ok: results.every((row) => row.ok), results };
    }
    if (name === "local.fs_copy" || name === "local.fs_move") {
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
      if (name === "local.fs_move" && overwrite) {
        await rename(source, destination);
      } else {
        // cp's exclusive mode also protects against destinations created after validation.
        await cp(source, destination, { recursive: true, force: overwrite, errorOnExist: !overwrite, dereference: false, verbatimSymlinks: true });
        if (name === "local.fs_move") await rm(source, { recursive: true });
      }
      return { ok: true, source, destination };
    }
    const path = pathArg(input);
    switch (name) {
      case "local.fs_stat": {
        const stat = await lstat(path);
        return { ok: true, path, type: typeOf(stat), size: stat.size, modifiedAt: stat.mtime.toISOString(), mode: stat.mode };
      }
      case "local.fs_list": {
        const limit = integer(input, "limit", 200, 1, 1000);
        const entries: Record<string, unknown>[] = [];
        let truncated = false;
        for await (const entry of await opendir(path)) {
          if (entries.length >= limit) { truncated = true; break; }
          entries.push({ name: entry.name, path: join(path, entry.name), type: typeOf(entry) });
        }
        return { ok: true, path, entries, truncated };
      }
      case "local.replace_block": {
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
      case "local.fs_write": {
        if (typeof input.content !== "string") throw new Error("content must be a string");
        const append = flag(input, "append");
        const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NONBLOCK | (append ? constants.O_APPEND : 0));
        try {
          if (!(await file.stat()).isFile()) throw new Error("path must be a regular file");
          if (!append) await file.truncate(0);
          await file.writeFile(input.content, "utf8");
        } finally { await file.close(); }
        return { ok: true, path, bytesWritten: Buffer.byteLength(input.content), append };
      }
      case "local.fs_mkdir":
        await mkdir(path, { recursive: flag(input, "recursive") });
        return { ok: true, path };
      case "local.fs_delete":
        if (path === resolve(path, "..")) throw new Error("cannot delete filesystem root");
        await rm(path, { recursive: flag(input, "recursive"), force: false });
        return { ok: true, path };
      case "local.fs_search": {
        if (typeof input.query !== "string" || !input.query.length) throw new Error("query must be a non-empty filename substring");
        const limit = integer(input, "limit", 100, 1, 1000);
        const maxEntries = integer(input, "maxEntries", 10000, 1, 100000);
        if (!(await lstat(path)).isDirectory()) throw new Error("path must be a directory, not a symlink");
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
      }
      case "local.fs_grep": {
        if (typeof input.query !== "string" || !input.query.length || input.query.length > 500) {
          throw new Error("query must be a literal substring of 1 to 500 characters");
        }
        const query = input.query;
        const limit = integer(input, "limit", 50, 1, 200);
        const maxFiles = integer(input, "maxFiles", 400, 1, 5000);
        const maxFileBytes = integer(input, "maxFileBytes", 1048576, 1, 1048576);
        const maxEntries = integer(input, "maxEntries", 10000, 1, 100000);
        const contextChars = integer(input, "contextChars", 80, 0, 200);
        if (!(await lstat(path)).isDirectory()) throw new Error("path must be a directory, not a symlink");
        const pending = [path];
        const matches: Record<string, unknown>[] = [];
        let scannedFiles = 0;
        let scannedEntries = 0;
        let truncated = false;
        const skipped: { path: string; reason: string }[] = [];
        const errors: { path: string; error: string }[] = [];
        const skipDirs = new Set(["node_modules", ".git"]);
        outer: while (pending.length) {
          const directory = pending.pop()!;
          try {
            for await (const entry of await opendir(directory)) {
              if (scannedEntries >= maxEntries || matches.length >= limit) { truncated = true; break outer; }
              scannedEntries++;
              const entryPath = join(directory, entry.name);
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
              if (scannedFiles >= maxFiles) { truncated = true; break outer; }
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
              let from = 0;
              while (matches.length < limit) {
                const at = text.indexOf(query, from);
                if (at === -1) break;
                const lineStart = text.lastIndexOf("\n", at - 1) + 1;
                const lineEnd = text.indexOf("\n", at);
                const lineText = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
                const column = at - lineStart + 1;
                const line = text.slice(0, at).split("\n").length;
                matches.push({
                  path: entryPath,
                  line,
                  column,
                  before: lineText.slice(Math.max(0, column - 1 - contextChars), column - 1),
                  hit: query,
                  after: lineText.slice(column - 1 + query.length, column - 1 + query.length + contextChars),
                });
                from = at + Math.max(query.length, 1);
                if (matches.length >= limit) { truncated = true; break outer; }
              }
            }
          } catch (error) {
            if (directory === path) throw error;
            if (errors.length < 100) errors.push({ path: directory, error: error instanceof Error ? error.message : String(error) });
            truncated = true;
          }
        }
        return { ok: true, path, matches, scannedFiles, scannedEntries, truncated, skipped, errors };
      }
      default: throw new Error(`Unknown local file tool: ${name}`);
    }
  } catch (error) {
    return { ok: false, ...errorInfo(error), error: error instanceof Error ? error.message : String(error) };
  }
}
