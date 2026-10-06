import { errorInfo } from "../../shared/errors.ts";
import { lstat, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { retrievalWindowChars } from "../admission.ts";
import { buildBlockIndex, readBlock, type BlockIndex } from "../evidence/index.ts";
import { integer, pathArg } from "./local-files.ts";

/** 文件内容与工具返回共用块索引；回调保存当次不可变原文，块 ID 由 evidence_search 读取。 */
export async function runFsOutline(input: Record<string, unknown>, onIndex?: (index: BlockIndex) => void): Promise<Record<string, unknown>> {
  try {
    const path = pathArg(input);
    const maxFileBytes = integer(input, "maxFileBytes", 1048576, 1, 1048576);
    const stat = await lstat(path);
    if (!stat.isFile()) throw new Error("path must be a regular file");
    if (stat.size > maxFileBytes) throw new Error(`file exceeds maxFileBytes (${stat.size} > ${maxFileBytes})`);
    const text = await readFile(path, "utf8");
    const index = buildBlockIndex(text, { path, maxChars: retrievalWindowChars() });
    onIndex?.(index);
    return { ok: true, path, name: basename(path), bytes: stat.size, totalChars: text.length,
      totalLines: text.length ? text.split("\n").length : 0, rootId: index.rootId, block: readBlock(index, index.rootId) };
  } catch (error) {
    const { faultCode, detail } = errorInfo(error, "tool_execution_failed");
    return { ok: false, path: typeof input.path === "string" ? input.path : undefined, faultCode, error: detail };
  }
}
