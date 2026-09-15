import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { handleTurn, type LoopDeps } from "./runtime/loop.ts";
import { resolveProxy } from "./provider/uuapi.ts";
import { configuredProvider, isProviderName, providerOptions } from "./provider/config.ts";
import { ensureSession, loadSession, defaultDataDir, currentSessionView, listConversations, openConversation, newConversation, deleteConversation, stopTurn } from "./runtime/store.ts";
import { createToolBridge, type ToolBridge } from "./runtime/bridge.ts";
import type { BrowserResult, BrowserHost, OpenTabs } from "./types.ts";
import { executorVersion, executorMismatchMessage } from "./executor-version.ts";
import { abortAllLocalProcesses } from "./tools/local-process.ts";
import { cancelAllExecutions } from "./runtime/execution.ts";
import { listItems, saveItem, deleteItem, LibraryError } from "./library/store.ts";

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
  const savedConnection = existsSync(connectionPath)
    ? JSON.parse(readFileSync(connectionPath, "utf8")) : null;
  let proxyEnabled = savedConnection ? savedConnection.enabled === true : Bun.env.TCHROME_PROXY_MODE === "proxy";
  let providerName = savedConnection?.provider ?? Bun.env.TCHROME_PROVIDER ?? "uuapi";
  const connectionView = () => ({ enabled: proxyEnabled, provider: providerName, providers: providerOptions });
  const proxyURL = resolveProxy({ ...Bun.env, TCHROME_PROXY_MODE: "proxy" });
  let activeProvider = configuredProvider(proxyEnabled ? proxyURL : "", providerName);
  const provider = options.provider ?? { complete: (input: Parameters<typeof activeProvider.complete>[0]) => activeProvider.complete(input) };
  const bridge = options.bridge ?? createToolBridge(dataDir);
  const expectedVersion = executorVersion(repoRoot);
  let extension: { status: "unknown" | "ready" | "mismatch"; expectedVersion: string; actualVersion: string | null; lastSeenAt: string | null; error?: string } = {
    status: "unknown", expectedVersion, actualVersion: null, lastSeenAt: null,
  };
  const extensionStaleMs = 45_000;
  const extensionView = () => ({ ...extension, status: extension.lastSeenAt && Date.now() - Date.parse(extension.lastSeenAt) >= extensionStaleMs ? "disconnected" : extension.status });
  const snapshotHost = (scope?: string): BrowserHost => {
    const scoped = scope === undefined ? bridge : bridge.forScope!(scope);
    return { ...scoped, forScope: snapshotHost, readOpenTabs: async (): Promise<OpenTabs> => {
      const unavailable = (): OpenTabs => ({ok: false, error: extensionView().error || "浏览器扩展未连接，无法读取标签列表"});
      if (extensionView().status !== "ready") return unavailable();
      let timer: ReturnType<typeof setTimeout>;
      let disconnected = false;
      const checkConnection = () => {
        if (extensionView().status !== "ready") {
          disconnected = true;
          scoped.abort?.();
        } else {
          timer = setTimeout(checkConnection, Math.max(1, extensionStaleMs - (Date.now() - Date.parse(extension.lastSeenAt!))));
        }
      };
      const pendingSnapshot = scoped.readOpenTabs!();
      checkConnection();
      try {
        const result = await pendingSnapshot;
        return disconnected ? unavailable() : result;
      } finally { clearTimeout(timer!); }
    } };
  };
  const host = options.host ?? snapshotHost();
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
    get providerName() { return providerName; },
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
        return respond({ ok: true, extension: extensionView() });
      }
      if ((request.method === "GET" && url.pathname === "/tool-request") || (request.method === "POST" && url.pathname === "/tool-result")) {
        const actualVersion = url.searchParams.get("executorVersion");
        const matches = actualVersion === expectedVersion;
        extension = { status: matches ? "ready" : "mismatch", expectedVersion, actualVersion, lastSeenAt: new Date().toISOString(), ...(!matches ? { error: executorMismatchMessage } : {}) };
        if (!matches) {
          const pending = bridge.current();
          if (pending) bridge.resolve(pending.id, { ok: false, error: `executor_version_mismatch: ${executorMismatchMessage}` });
          return respond({ ok: false, request: null, executorVersion: expectedVersion, faultCode: "executor_version_mismatch", error: executorMismatchMessage }, 409);
        }
      }
      if (request.method === "GET" && url.pathname === "/tool-request") {
        return respond({ executorVersion: expectedVersion, request: bridge.current() });
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
      if ((request.method === "GET" && url.pathname === "/library")
        || (request.method === "POST" && ["/library/save", "/library/delete"].includes(url.pathname))) {
        try {
          if (request.method === "GET") return respond({ items: listItems(dataDir, url.searchParams.get("q") ?? "") });
          const body = await request.json().catch(() => { throw new LibraryError("请求内容必须是有效的 JSON"); });
          if (url.pathname === "/library/save") return respond({ item: saveItem(dataDir, body) });
          if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.id !== "string") throw new LibraryError("缺少资料 id");
          deleteItem(dataDir, body.id);
          return respond({ ok: true });
        } catch (error) {
          if (error instanceof LibraryError) return respond({ error: error.message }, error.status);
          console.error("资料库读写失败", error);
          return respond({ error: "资料库读写失败，请检查本地目录权限与服务日志" }, 500);
        }
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
      if (request.method === "GET" && url.pathname === "/connection") return respond(connectionView());
      if (request.method === "POST" && url.pathname === "/connection") {
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object" || Array.isArray(body)
          || !("enabled" in body || "provider" in body)) return respond({ error: "invalid_connection" }, 400);
        if ("enabled" in body && typeof body.enabled !== "boolean") return respond({ error: "invalid_enabled" }, 400);
        if ("provider" in body && !isProviderName(body.provider)) return respond({ error: "invalid_provider" }, 400);
        const nextEnabled = body.enabled ?? proxyEnabled;
        const nextName = body.provider ?? providerName;
        if (nextName !== providerName && !Bun.env[nextName === "uuapi" ? "UUAPI_API_KEY" : "SHININGSPACE_API_KEY"]?.trim()) {
          return respond({ error: "所选 provider 尚未配置 API Key" }, 400);
        }
        try {
          const nextProvider = configuredProvider(nextEnabled ? proxyURL : "", nextName);
          mkdirSync(dataDir, { recursive: true });
          writeFileSync(`${connectionPath}.tmp`, JSON.stringify({ enabled: nextEnabled, provider: nextName }));
          renameSync(`${connectionPath}.tmp`, connectionPath);
          proxyEnabled = nextEnabled;
          providerName = nextName;
          activeProvider = nextProvider;
          return respond(connectionView());
        } catch {
          return respond({ error: "连接设置保存失败，请检查 provider 配置及本地目录权限" }, 500);
        }
      }
      if (request.method === "POST" && url.pathname === "/turn") {
        const body = (await request.json()) as { conversationId?: string; userInput?: string; submittedAt?: string };
        const userInput = String(body.userInput ?? "").trim();
        if (!userInput) return respond({ conversationId: "", turnId: "", output: { kind: "error", faultCode: "empty_input" } }, 400);
        if (body.conversationId && body.conversationId !== ensureSession(dataDir).conversationId) {
          return respond({ output: { kind: "error", faultCode: "conversation_changed" } }, 409);
        }
        const submittedAt = body.submittedAt || new Date().toISOString();
        const reply = await handleTurn(deps, { userInput, submittedAt });
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
      cancelAllExecutions();
      abortAllLocalProcesses();
      process.exit(0);
    });
  }
  console.log(`tChrome service http://${hostname}:${port}`);
  console.log(`Model connection: ${server.proxyEnabled ? "proxy" : "direct"}`);
  console.log(`Provider: ${server.providerName}`);
}
