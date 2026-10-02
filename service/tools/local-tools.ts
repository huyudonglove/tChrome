import { resolve } from "node:path";
import { LOCAL_FILE_TOOL_NAMES, runLocalFileTool } from "./local-files.ts";
import { LOCAL_PROCESS_TOOL_NAMES, runLocalProcessTool } from "./local-process.ts";
import { LOCAL_GIT_TOOL_NAMES, runLocalGitTool } from "./local-git.ts";
import { runLocalDiagnose } from "./local-diagnose.ts";
import { runTsxOutline } from "./tsx-outline.ts";
import { runFsOutline } from "./fs-outline.ts";
import { LOCAL_CODE_REFS_TOOL_NAMES, runCodeRefs } from "./code-refs.ts";
import { LOCAL_REPO_MAP_TOOL_NAMES, runRepoMap } from "./repo-map-tool.ts";

export const LOCAL_DIAGNOSE_TOOL_NAMES = ["local_diagnose"] as const;
export const LOCAL_TSX_TOOL_NAMES = ["local_tsx_outline"] as const;
export const LOCAL_OUTLINE_TOOL_NAMES = ["local_fs_outline"] as const;
export const LOCAL_TOOL_NAMES = [
  ...LOCAL_FILE_TOOL_NAMES,
  ...LOCAL_PROCESS_TOOL_NAMES,
  ...LOCAL_GIT_TOOL_NAMES,
  ...LOCAL_DIAGNOSE_TOOL_NAMES,
  ...LOCAL_TSX_TOOL_NAMES,
  ...LOCAL_OUTLINE_TOOL_NAMES,
  ...LOCAL_CODE_REFS_TOOL_NAMES,
  ...LOCAL_REPO_MAP_TOOL_NAMES,
];
export const localScope = (dataDir: string, conversationId: string) => JSON.stringify([resolve(dataDir), conversationId]);

export async function runLocalTool(name: string, input: Record<string, unknown>, dataDir: string, conversationId: string) {
  if (name === "local_diagnose") return runLocalDiagnose(input);
  if ((LOCAL_TSX_TOOL_NAMES as readonly string[]).includes(name)) return runTsxOutline(input);
  if ((LOCAL_OUTLINE_TOOL_NAMES as readonly string[]).includes(name)) return runFsOutline(input);
  if (name === "local_code_refs") return runCodeRefs(input);
  if ((LOCAL_REPO_MAP_TOOL_NAMES as readonly string[]).includes(name)) return runRepoMap(input);
  if ((LOCAL_FILE_TOOL_NAMES as readonly string[]).includes(name)) return runLocalFileTool(name, input);
  if ((LOCAL_GIT_TOOL_NAMES as readonly string[]).includes(name)) return runLocalGitTool(name, input);
  return runLocalProcessTool(name, input, localScope(dataDir, conversationId), dataDir);
}
