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
  /** Requests handed to the extension; every returned request is marked as dispatched. */
  listForDispatch(): ToolRequest[];
  resolve(id: string, result: BrowserResult): boolean;
  abort(scope?: string): void;
  abortById(id: string): boolean;
};

type Pending = {
  request: ToolRequest;
  scope?: string;
  done: (result: BrowserResult) => void;
  /** True once the extension has been handed this request to execute. */
  dispatched?: boolean;
};

export function createToolBridge(dataDir: string): ToolBridge {
  const queue: Pending[] = [];

  const enqueue = (scope: string | undefined, name: string, input: Record<string, unknown>): ToolRequest => {
    const request: ToolRequest = { id: allocateRecordId(dataDir, null, "bridge"), name, input };
    return request;
  };
  const withTimeout = (
    done: (result: BrowserResult) => void,
    dispatched: () => boolean,
  ): ((result: BrowserResult) => void) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // A request stays queued until it settles, so "still listed" cannot separate a
      // request the extension never picked up from one it picked up and never answered.
      // The dispatch marker is what makes those two cases distinguishable.
      done(dispatched()
        ? {
            ok: false,
            faultCode: "tool_execution_failed",
            executionState: "claimed_no_result",
            recovery: "inspect_state",
            error: `浏览器执行等待超时（${BRIDGE_TIMEOUT_MS}ms）：扩展已领取该请求但未回传结果，操作可能已经生效、页面可能已经变化。请先核对当前页面与已保存记录，不要直接重放。`,
          }
        : {
            ok: false,
            faultCode: "tool_execution_failed",
            executionState: "not_claimed",
            recovery: "inspect_state",
            error: `浏览器执行等待超时（${BRIDGE_TIMEOUT_MS}ms）：请求一直未被扩展领取（扩展可能未连接或已失联），页面很可能没有发生变化。`,
          });
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
      }, () => item.dispatched === true);
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
    listForDispatch: () => queue.map((item) => {
      item.dispatched = true;
      return item.request;
    }),
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
