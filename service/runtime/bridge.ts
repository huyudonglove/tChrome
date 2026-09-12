import { allocateRecordId } from "./ids.ts";
import type { BrowserHost, BrowserResult } from "../types.ts";

export type ToolRequest = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolBridge = BrowserHost & {
  current(): ToolRequest | null;
  resolve(id: string, result: BrowserResult): boolean;
  abort(scope?: string): void;
};

type Pending = {
  request: ToolRequest;
  scope?: string;
  done: (result: BrowserResult) => void;
};

export function createToolBridge(dataDir: string): ToolBridge {
  const queue: Pending[] = [];

  const finish = (id: string, result: BrowserResult): boolean => {
    const next = queue[0];
    if (!next || next.request.id !== id) return false;
    queue.shift();
    next.done(result);
    return true;
  };
  const execute = (scope: string | undefined, name: string, input: Record<string, unknown>): Promise<BrowserResult> =>
    new Promise((done) => {
      queue.push({ request: { id: allocateRecordId(dataDir, null, "bridge"), name, input }, scope, done });
    });
  const abort = (scope?: string) => {
    const removed: Pending[] = [];
    for (let i = queue.length - 1; i >= 0; i--) {
      if (scope === undefined || queue[i]?.scope === scope) removed.push(...queue.splice(i, 1));
    }
    for (const item of removed) item.done({ ok: false, faultCode: "stopped", error: "已停止" });
  };
  return {
    execute: (name, input) => execute(undefined, name, input),
    forScope: (scope) => ({ execute: (name, input) => execute(scope, name, input), abort: () => abort(scope) }),
    current: () => queue[0]?.request ?? null,
    resolve: finish,
    abort,
  };
}
