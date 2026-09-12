import { errorInfo } from "../../shared/errors.ts";
import { resolve, dirname, basename, join, sep, isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";
import { LOCAL_FILE_TOOL_NAMES, runLocalFileTool } from "./local-files.ts";
import { LOCAL_PROCESS_TOOL_NAMES, runLocalProcessTool } from "./local-process.ts";

export const LOCAL_TOOL_NAMES = [...LOCAL_FILE_TOOL_NAMES, ...LOCAL_PROCESS_TOOL_NAMES];
export const localScope = (dataDir: string, conversationId: string) => JSON.stringify([resolve(dataDir), conversationId]);

async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalPath(parent), basename(path));
  }
}
const overlaps = (left: string, right: string) => left === right || left.startsWith(right.endsWith(sep) ? right : right + sep) || right.startsWith(left.endsWith(sep) ? left : left + sep);
async function protectScripts(name: string, input: Record<string, unknown>, dataDir: string) {
  const keys = name === "local.fs_copy" ? ["destination"] : name === "local.fs_move" ? ["source", "destination"]
    : ["local.fs_write", "local.fs_mkdir", "local.fs_delete"].includes(name) ? ["path"] : [];
  if (!keys.length) return;
  const scripts = resolve(dataDir, "scripts");
  const canonicalScripts = await canonicalPath(scripts);
  for (const key of keys) {
    const value = input[key];
    if (typeof value !== "string" || !isAbsolute(value)) continue;
    if (overlaps(resolve(value), scripts) || overlaps(await canonicalPath(value), canonicalScripts)) {
      throw new Error("Managed scripts must be changed through script_patch");
    }
  }
}

export async function runLocalTool(name: string, input: Record<string, unknown>, dataDir: string, conversationId: string) {
  if ((LOCAL_FILE_TOOL_NAMES as readonly string[]).includes(name)) {
    try { await protectScripts(name, input, dataDir); }
    catch (error) { return { ok: false, ...errorInfo(error), error: error instanceof Error ? error.message : String(error) }; }
    return runLocalFileTool(name, input);
  }
  return runLocalProcessTool(name, input, localScope(dataDir, conversationId), dataDir);
}
