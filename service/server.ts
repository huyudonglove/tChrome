import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleTurn, type LoopDeps } from "./runtime/loop.ts";
import { createProvider, resolveProxy } from "./provider/uuapi.ts";
import { ensureSession, loadSession, defaultDataDir, currentSessionView, listConversations, openConversation, newConversation, deleteConversation, stopTurn } from "./runtime/store.ts";
import { createToolBridge, type ToolBridge } from "./runtime/bridge.ts";
import type { BrowserResult } from "./types.ts";
import { abortAllLocalProcesses } from "./tools/local-process.ts";

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
  extensionOrigin?: string;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "vary": "Origin",
    },
  });

export function createServer(options: ServeOptions = {}) {
  const repoRoot = options.repoRoot ?? process.cwd();
  const dataDir = options.dataDir ?? defaultDataDir();
  const connectionPath = join(dataDir, "connection.json");
  let proxyEnabled = existsSync(connectionPath)
    ? JSON.parse(readFileSync(connectionPath, "utf8")).enabled === true
    : Bun.env.TCHROME_PROXY_MODE === "proxy";
  const proxyURL = resolveProxy({ ...Bun.env, TCHROME_PROXY_MODE: "proxy" });
  let activeProvider = createProvider({ proxy: proxyEnabled ? proxyURL : "" });
  const provider = options.provider ?? { complete: (input: Parameters<typeof activeProvider.complete>[0]) => activeProvider.complete(input) };
  const bridge = options.bridge ?? createToolBridge();
  const host = options.host ?? bridge;
  const deps: LoopDeps = { dataDir, repoRoot, provider, host };
  const extensionOrigin = options.extensionOrigin ?? Bun.env.TCHROME_EXTENSION_ORIGIN;
  const trustedOrigin = (origin: string, url: URL) =>
    origin === url.origin || (extensionOrigin
      ? origin === extensionOrigin
      : /^chrome-extension:\/\/[a-p]{32}$/.test(origin));
  return {
    dataDir,
    bridge,
    get proxyEnabled() { return proxyEnabled; },
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      const origin = request.headers.get("origin");
      // Check before routing: omitting CORS headers alone cannot prevent writes.
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        || (origin !== null && !trustedOrigin(origin, url))
        || (origin === null && ["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site") ?? ""))) {
        return json({ error: "forbidden origin" }, 403);
      }
      const respond = (body: unknown, status = 200) => {
        const response = json(body, status);
        if (origin) response.headers.set("access-control-allow-origin", origin);
        return response;
      };
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            ...(origin ? { "access-control-allow-origin": origin } : {}),
            "vary": "Origin",
            "access-control-allow-methods": "GET,POST,OPTIONS",
            "access-control-allow-headers": "content-type",
          },
        });
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return respond({ ok: true });
      }
      if (request.method === "GET" && url.pathname === "/tool-request") {
        return respond({ request: bridge.current() });
      }
      if (request.method === "POST" && url.pathname === "/tool-result") {
        const body = (await request.json()) as { id?: string; result?: BrowserResult };
        if (!body.id || !body.result) return respond({ ok: false, error: "缺 id 或 result" }, 400);
        if (!bridge.resolve(body.id, body.result)) return respond({ ok: false, error: "没有这个工具请求" }, 404);
        return respond({ ok: true });
      }
      if (request.method === "GET" && url.pathname === "/session") {
        return respond(currentSessionView(dataDir));
      }
      if (request.method === "GET" && url.pathname === "/conversations") {
        return respond({ items: listConversations(dataDir) });
      }
      if (request.method === "POST" && url.pathname === "/conversations/open") {
        const body = (await request.json()) as { conversationId?: string };
        const conversationId = String(body.conversationId ?? "");
        if (!conversationId) return respond({ error: "缺 conversationId" }, 400);
        try {
          return respond(openConversation(dataDir, conversationId));
        } catch (error) {
          return respond({ error: error instanceof Error ? error.message : String(error) }, 404);
        }
      }
      if (request.method === "POST" && url.pathname === "/conversations/new") {
        return respond(newConversation(dataDir));
      }
      if (request.method === "POST" && url.pathname === "/conversations/delete") {
        const body = (await request.json()) as { conversationId?: string };
        const conversationId = String(body.conversationId ?? "");
        if (!conversationId) return respond({ error: "缺 conversationId" }, 400);
        try {
          const next = deleteConversation(dataDir, conversationId);
          host.abort?.(conversationId);
          return respond(next);
        } catch (error) {
          return respond({ error: error instanceof Error ? error.message : String(error) }, 404);
        }
      }
      if (request.method === "GET" && url.pathname === "/connection") return respond({ enabled: proxyEnabled });
      if (request.method === "POST" && url.pathname === "/connection") {
        const body = await request.json() as { enabled: boolean };
        if (typeof body.enabled !== "boolean") return respond({ error: "invalid_enabled" }, 400);
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(connectionPath, JSON.stringify({ enabled: body.enabled }));
        proxyEnabled = body.enabled;
        activeProvider = createProvider({ proxy: proxyEnabled ? proxyURL : "" });
        return respond({ enabled: proxyEnabled });
      }
      if (request.method === "POST" && url.pathname === "/turn") {
        const body = (await request.json()) as { conversationId?: string; userInput?: string; submittedAt?: string; currentTab?: { tab?: number; url?: string; title?: string } | null };
        const userInput = String(body.userInput ?? "").trim();
        if (!userInput) return respond({ conversationId: "", turnId: "", output: { kind: "error", faultCode: "empty_input" } }, 400);
        if (body.conversationId && body.conversationId !== ensureSession(dataDir).conversationId) {
          return respond({ output: { kind: "error", faultCode: "conversation_changed" } }, 409);
        }
        const submittedAt = body.submittedAt || new Date().toISOString();
        const reply = await handleTurn(deps, { userInput, submittedAt, currentTab: body.currentTab ?? null });
        return respond(reply);
      }
      if (request.method === "POST" && url.pathname === "/stop") {
        const raw = await request.text();
        const target = raw ? (JSON.parse(raw) as { conversationId?: string | null }).conversationId : undefined;
        const conversationId = loadSession(dataDir)?.conversationId;
        if (target !== undefined && target !== conversationId) {
          return respond({ error: "会话已切换，停止请求已忽略" }, 409);
        }
        const stopped = stopTurn(dataDir);
        if (conversationId) host.abort?.(conversationId);
        return respond(stopped);
      }
      return respond({ error: "not found" }, 404);
    },
  };
}

const isMain = import.meta.main;
if (isMain) {
  const hostname = "127.0.0.1";
  const port = 18788;
  const server = createServer();
  Bun.serve({ hostname, port, fetch: server.fetch });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      abortAllLocalProcesses();
      process.exit(0);
    });
  }
  console.log(`tChrome service http://${hostname}:${port}`);
  console.log(`Model connection: ${server.proxyEnabled ? "proxy" : "direct"}`);
}
