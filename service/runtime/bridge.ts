import { allocateRecordId } from "./ids.ts";
import type { BrowserHost, BrowserResult, CurrentTabs } from "../types.ts";

/** Browser tools wait for the extension; a vanished executor must not hang the turn. */
export const BRIDGE_TIMEOUT_MS = 120_000;

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
  const withTimeout = (done: (result: BrowserResult) => void): ((result: BrowserResult) => void) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      done({ ok: false, faultCode: "tool_execution_failed", error: `浏览器执行等待超时（${BRIDGE_TIMEOUT_MS}ms）：执行器未返回，可能是标签页挂死或扩展失联` });
    }, BRIDGE_TIMEOUT_MS);
    return (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(result);
    };
  };
  /** Push a pending item whose settle path (result, timeout, or abort) always dequeues it. */
  const push = (scope: string | undefined, request: ToolRequest): Promise<BrowserResult> =>
    new Promise((done) => {
      const item: Pending = { request, scope, done: () => {} };
      item.done = withTimeout((result) => {
        const index = queue.indexOf(item);
        if (index >= 0) queue.splice(index, 1);
        done(result);
      });
      queue.push(item);
    });
  const execute = (scope: string | undefined, name: string, input: Record<string, unknown>): Promise<BrowserResult> =>
    push(scope, enqueue(scope, name, input));
  const executeTracked = (scope: string | undefined, name: string, input: Record<string, unknown>): { id: string; result: Promise<BrowserResult> } => {
    const request = enqueue(scope, name, input);
    return { id: request.id, result: push(scope, request) };
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
  const readCurrentTabs = async (scope?: string): Promise<CurrentTabs> =>
    await execute(scope, "__currentTabs", {}) as unknown as CurrentTabs;
  const scopedHost = (scope?: string): BrowserHost => ({
    readCurrentTabs: () => readCurrentTabs(scope),
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
