import type { BrowserHost, BrowserResult } from "../types.ts";

export type ToolRequest = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolBridge = BrowserHost & {
  current(): ToolRequest | null;
  resolve(id: string, result: BrowserResult): boolean;
};

export function createToolBridge(timeoutMs = 30000): ToolBridge {
  const pending = new Map<string, (result: BrowserResult) => void>();
  let current: ToolRequest | null = null;
  let seq = 0;

  return {
    execute: (name, input) =>
      new Promise((resolve) => {
        const id = `br_${Date.now()}_${++seq}`;
        pending.set(id, resolve);
        setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          if (current?.id === id) current = null;
          resolve({ ok: false, error: "浏览器工具超时" });
        }, timeoutMs);
        current = { id, name, input };
      }),
    current: () => current,
    resolve: (id, result) => {
      const done = pending.get(id);
      if (!done) return false;
      pending.delete(id);
      if (current?.id === id) current = null;
      done(result);
      return true;
    },
  };
}
