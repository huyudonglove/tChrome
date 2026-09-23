import { allocateRecordId } from "./ids.ts";
import type { BrowserHost, BrowserResult, OpenTabs } from "../types.ts";

export type ToolRequest = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolBridge = BrowserHost & {
  /** All unclaimed requests; the extension may execute several at once. */
  list(): ToolRequest[];
  resolve(id: string, result: BrowserResult): boolean;
  abort(scope?: string): void;
  abortById(id: string): boolean;
};

type Pending = {
  request: ToolRequest;
  scope?: string;
  done: (result: BrowserResult) => void;
};

export function createToolBridge(dataDir: string): ToolBridge {
  const queue: Pending[] = [];

  const enqueue = (scope: string | undefined, name: string, input: Record<string, unknown>): ToolRequest => {
    const request: ToolRequest = { id: allocateRecordId(dataDir, null, "bridge"), name, input };
    return request;
  };
  const execute = (scope: string | undefined, name: string, input: Record<string, unknown>): Promise<BrowserResult> =>
    new Promise((done) => {
      const request = enqueue(scope, name, input);
      queue.push({ request, scope, done });
    });
  const executeTracked = (scope: string | undefined, name: string, input: Record<string, unknown>): { id: string; result: Promise<BrowserResult> } => {
    const request = enqueue(scope, name, input);
    const result = new Promise<BrowserResult>((done) => {
      queue.push({ request, scope, done });
    });
    return { id: request.id, result };
  };
  const abort = (scope?: string) => {
    const removed: Pending[] = [];
    for (let i = queue.length - 1; i >= 0; i--) {
      if (scope === undefined || queue[i]?.scope === scope) removed.push(...queue.splice(i, 1));
    }
    for (const item of removed) item.done({ ok: false, faultCode: "stopped", error: "已停止" });
  };
  const abortById = (id: string): boolean => {
    const index = queue.findIndex((item) => item.request.id === id);
    if (index < 0) return false;
    const [item] = queue.splice(index, 1);
    item?.done({ ok: false, faultCode: "stopped", error: "已停止" });
    return true;
  };
  const readOpenTabs = async (scope?: string): Promise<OpenTabs> =>
    await execute(scope, "__openTabs", {}) as unknown as OpenTabs;
  const scopedHost = (scope?: string): BrowserHost => ({
    readOpenTabs: () => readOpenTabs(scope),
    execute: (name, input) => execute(scope, name, input),
    executeTracked: (name, input) => executeTracked(scope, name, input),
    abort: () => abort(scope),
    abortById,
    forScope: scopedHost,
  });
  return {
    ...scopedHost(undefined),
    list: () => queue.map((item) => item.request),
    resolve: (id, result) => {
      const index = queue.findIndex((item) => item.request.id === id);
      if (index < 0) return false;
      const [item] = queue.splice(index, 1);
      item?.done(result);
      return true;
    },
    abort,
    abortById,
    forScope: scopedHost,
  };
}
