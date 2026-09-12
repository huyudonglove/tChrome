import { errorInfo } from "../../shared/errors.ts";
import { constants } from "node:fs";
import { cp, lstat, mkdir, open, opendir, rename, rm } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

export const LOCAL_FILE_TOOL_NAMES = [
  "local.fs_list", "local.fs_stat", "local.fs_read", "local.fs_write", "local.fs_mkdir",
  "local.fs_copy", "local.fs_move", "local.fs_delete", "local.fs_search",
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

export async function runLocalFileTool(name: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  try {
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
      case "local.fs_read": {
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
      default: throw new Error(`Unknown local file tool: ${name}`);
    }
  } catch (error) {
    return { ok: false, ...errorInfo(error), error: error instanceof Error ? error.message : String(error) };
  }
}
