import { resolve } from "node:path";
import { LOCAL_FILE_TOOL_NAMES, runLocalFileTool } from "./local-files.ts";
import { LOCAL_PROCESS_TOOL_NAMES, runLocalProcessTool } from "./local-process.ts";

export const LOCAL_TOOL_NAMES = [...LOCAL_FILE_TOOL_NAMES, ...LOCAL_PROCESS_TOOL_NAMES];
export const localScope = (dataDir: string, conversationId: string) => JSON.stringify([resolve(dataDir), conversationId]);

export async function runLocalTool(name: string, input: Record<string, unknown>, dataDir: string, conversationId: string) {
  if ((LOCAL_FILE_TOOL_NAMES as readonly string[]).includes(name)) return runLocalFileTool(name, input);
  return runLocalProcessTool(name, input, localScope(dataDir, conversationId));
}
