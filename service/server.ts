import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { handleTurn, type LoopDeps } from "./runtime/loop.ts";
import { createProvider } from "./provider/uuapi.ts";
import { defaultDataDir, currentSessionView, listConversations, openConversation, newConversation, deleteConversation, stopTurn } from "./runtime/store.ts";
import { createToolBridge, type ToolBridge } from "./runtime/bridge.ts";
import type { BrowserResult } from "./types.ts";

const loadEnv = () => {
  const envPath = join(import.meta.dir, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!Bun.env[key]) Bun.env[key] = value;
  }
};
loadEnv();

export type ServeOptions = {
  dataDir?: string;
  repoRoot?: string;
  provider?: LoopDeps["provider"];
  host?: LoopDeps["host"];
  bridge?: ToolBridge;
  port?: number;
  hostname?: string;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });

export function createServer(options: ServeOptions = {}) {
  const repoRoot = options.repoRoot ?? process.cwd();
  const dataDir = options.dataDir ?? defaultDataDir();
  const provider = options.provider ?? createProvider();
  const bridge = options.bridge ?? createToolBridge();
  const host = options.host ?? bridge;
  const deps: LoopDeps = { dataDir, repoRoot, provider, host };
  return {
    dataDir,
    bridge,
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET,POST,OPTIONS",
            "access-control-allow-headers": "content-type",
          },
        });
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true });
      }
      if (request.method === "GET" && url.pathname === "/tool-request") {
        return json({ request: bridge.current() });
      }
      if (request.method === "POST" && url.pathname === "/tool-result") {
        const body = (await request.json()) as { id?: string; result?: BrowserResult };
        if (!body.id || !body.result) return json({ ok: false, error: "缺 id 或 result" }, 400);
        if (!bridge.resolve(body.id, body.result)) return json({ ok: false, error: "没有这个工具请求" }, 404);
        return json({ ok: true });
      }
      if (request.method === "GET" && url.pathname === "/session") {
        return json(currentSessionView(dataDir));
      }
      if (request.method === "GET" && url.pathname === "/conversations") {
        return json({ items: listConversations(dataDir) });
      }
      if (request.method === "POST" && url.pathname === "/conversations/open") {
        const body = (await request.json()) as { conversationId?: string };
        const conversationId = String(body.conversationId ?? "");
        if (!conversationId) return json({ error: "缺 conversationId" }, 400);
        try {
          return json(openConversation(dataDir, conversationId));
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 404);
        }
      }
      if (request.method === "POST" && url.pathname === "/conversations/new") {
        return json(newConversation(dataDir));
      }
      if (request.method === "POST" && url.pathname === "/conversations/delete") {
        const body = (await request.json()) as { conversationId?: string };
        const conversationId = String(body.conversationId ?? "");
        if (!conversationId) return json({ error: "缺 conversationId" }, 400);
        try {
          return json(deleteConversation(dataDir, conversationId));
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 404);
        }
      }
      if (request.method === "POST" && url.pathname === "/turn") {
        const body = (await request.json()) as { userInput?: string; submittedAt?: string; currentTab?: { tab?: number; url?: string; title?: string } | null };
        const userInput = String(body.userInput ?? "").trim();
        if (!userInput) return json({ conversationId: "", turnId: "", output: { kind: "error", faultCode: "empty_input" } }, 400);
        const submittedAt = body.submittedAt || new Date().toISOString();
        const reply = await handleTurn(deps, { userInput, submittedAt, currentTab: body.currentTab ?? null });
        return json(reply);
      }
      if (request.method === "POST" && url.pathname === "/stop") {
        host.abort?.();
        return json(stopTurn(dataDir));
      }
      return json({ error: "not found" }, 404);
    },
  };
}

const isMain = import.meta.main;
if (isMain) {
  const hostname = "127.0.0.1";
  const port = 18788;
  const server = createServer();
  Bun.serve({ hostname, port, fetch: server.fetch });
  console.log(`tChrome service http://${hostname}:${port}`);
}
