import { isAbsolute, normalize } from "node:path";
import capabilityMetadata from "../capabilities/metadata.json";

export type WorkspaceEvidence = {
  target: { kind: "file" | "browser" | "script" | "process" | "tool"; key: string; scope?: string };
  op: string;
  files?: string[];
  result: unknown;
  content?: unknown;
  args?: Record<string, unknown>;
  range?: { startLine?: number; endLine?: number; offset?: number };
  mutation?: boolean;
};

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const filePath = (value: unknown): string | undefined => typeof value === "string" && isAbsolute(value) ? normalize(value) : undefined;
// Use the authoritative capability classification. False marks a possible change,
// including partial failures; it does not assert that the operation succeeded.
const mutations = new Set(Object.entries(capabilityMetadata.tools)
  .filter(([, metadata]) => metadata.readOnly === false).map(([name]) => name));
// These URLs identify network responses or cookie scopes, not the current page.
const nonPageUrls = new Set(["wait_response", "network_response_body", "set_cookie", "delete_cookie", "cookies", "download"]);
const identity = (value: unknown): string | number | undefined =>
  typeof value === "string" && value.length > 0 || typeof value === "number" && Number.isFinite(value) ? value as string | number : undefined;

/** Only tool contracts identify targets; commands and arbitrary output paths are not inferred. */
export function extractWorkspaceEvidence(name: string, args: Row, text: string, callId: string): WorkspaceEvidence[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  const root = record(parsed);
  const toolTarget = { kind: "tool" as const, key: `call:${callId}` };
  const make = (value: unknown, input: Row, path?: string, op = name, mutation = false): WorkspaceEvidence => {
    const row = record(value);
    const { content, ...metadata } = row;
    const range: NonNullable<WorkspaceEvidence["range"]> = {};
    const location = record(row.location);
    for (const key of ["startLine", "endLine", "offset"] as const) {
      const number = location[key] ?? row[key];
      if (typeof number === "number") range[key] = number;
    }
    return {
      target: path ? { kind: "file", key: path } : toolTarget,
      ...(path ? { files: [path] } : {}), op, args: input,
      result: value !== null && typeof value === "object" && !Array.isArray(value) ? metadata : value,
      ...(Object.hasOwn(row, "content") ? { content } : {}),
      ...(Object.keys(range).length ? { range } : {}),
      ...(mutation ? { mutation: true } : {}),
    };
  };
  if ((name === "local_fs_read" || name === "local_fs_search" || name === "evidence_search") && Array.isArray(root.results)) {
    const inputs = Array.isArray(args.items) ? args.items : Array.isArray(args.windows) ? args.windows : [];
    const evidence = root.results.map((value, index) => {
      const row = record(value);
      const input = record(inputs[index]);
      // Evidence storage's top-level path names a return artifact, not a source file.
      const sourcePath = filePath(record(row.location).path);
      const path = name === "evidence_search"
        ? sourcePath !== filePath(row.path) ? sourcePath : undefined
        : filePath(row.path) ?? filePath(input.path);
      return make(value, input, path);
    });
    const { results: _, ...status } = root;
    if (Object.keys(status).length) evidence.push(make(status, args));
    return evidence;
  }
  if (name === "local_fs_grep" && Array.isArray(root.matches)) {
    const { matches, ...status } = root;
    const evidence = [make(status, args, filePath(root.externalized === true ? undefined : root.path) ?? filePath(args.path))];
    const grouped = new Map<string | undefined, unknown[]>();
    for (const match of matches) {
      const path = filePath(record(match).path);
      const group = grouped.get(path) ?? [];
      group.push(match);
      grouped.set(path, group);
    }
    for (const [path, group] of grouped) evidence.push(make({ matches: group }, args, path));
    return evidence;
  }
  if (name === "local_fs_copy" || name === "local_fs_move") {
    return [
      make(parsed, args, filePath(root.source) ?? filePath(args.source), `${name}:source`, name === "local_fs_move"),
      make(parsed, args, filePath(root.destination) ?? filePath(args.destination), `${name}:destination`, true),
    ];
  }
  if (name.startsWith("local_fs_") || name === "local_replace_block") {
    const evidence = make(parsed, args, filePath(root.externalized === true ? undefined : root.path) ?? filePath(args.path), name === "local_fs_write" && args.append === true ? `${name}:append` : name, mutations.has(name));
    if (name === "local_fs_write" && root.externalized !== true && root.ok === true && args.append !== true && typeof args.content === "string") evidence.content = args.content;
    return [evidence];
  }
  const evidence = make(parsed, args, undefined, name, mutations.has(name));
  for (const field of ["processId", "jobId", "sessionId", "executionId"] as const) {
    const id = identity(root[field]) ?? identity(args[field]);
    if (id !== undefined) {
      evidence.target = { kind: "process", key: `${field}:${id}` };
      return [evidence];
    }
  }
  if (name.startsWith("script_") || name === "local_run") {
    const filename = identity(root.filename) ?? identity(args.filename);
    const path = name.startsWith("script_") ? filePath(root.externalized === true ? undefined : root.path) ?? filePath(args.path) : undefined;
    const scriptId = identity(root.scriptId) ?? identity(args.scriptId);
    if (filename !== undefined || path !== undefined || scriptId !== undefined) {
      evidence.target = { kind: "script", key: filename !== undefined ? `filename:${filename}` : path !== undefined ? `path:${path}` : `scriptId:${scriptId}` };
      if (path) evidence.files = [path];
      return [evidence];
    }
  }
  const tabId = identity(root.tabId) ?? identity(args.tabId);
  const url = nonPageUrls.has(name) || name.startsWith("network_") ? undefined : identity(root.url) ?? identity(args.url);
  if (tabId !== undefined) evidence.target = { kind: "browser", key: url !== undefined ? `tab:${tabId}:url:${url}` : `tab:${tabId}`, scope: `tab:${tabId}` };
  else if (typeof url === "string") evidence.target = { kind: "browser", key: `url:${url}` };
  return [evidence];
}
