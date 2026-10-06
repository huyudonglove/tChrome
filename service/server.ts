import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { runTurnWithContinuation, type LoopDeps } from "./runtime/loop.ts";
import { resolveProxy } from "./provider/uuapi.ts";
import { configuredProvider, isProviderName, providerApiKeyEnv, providerOptions } from "./provider/config.ts";
import { ensureSession, loadSession, defaultDataDir, currentSessionView, listConversations, listConversationIds, openConversation, newConversation, deleteConversation, stopTurn } from "./runtime/store.ts";
import { createToolBridge, type ToolBridge } from "./runtime/bridge.ts";
import { calibrateServiceCounters } from "./runtime/ids.ts";
import type { BrowserResult, BrowserHost, CurrentTabs } from "./types.ts";
import { executorVersion, executorMismatchMessage } from "./executor-version.ts";
import { abortAllLocalProcesses } from "./tools/local-process.ts";
import { cancelAllExecutions } from "./runtime/execution.ts";
import { listItems, saveItem, deleteItem, LibraryError } from "./library/store.ts";
import { readWidgetPage, saveWidgetHtml } from "./widgets/store.ts";
import { getStreamHub } from "./stream/pipe.ts";

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
  /** Installed runtime resources, independent of the development working directory. */
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
  const repoRoot = options.repoRoot ?? join(import.meta.dir, "..");
  const dataDir = options.dataDir ?? defaultDataDir();
  calibrateServiceCounters(dataDir);
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
    return { ...scoped, forScope: snapshotHost, readCurrentTabs: async (): Promise<CurrentTabs> => {
      const unavailable = (): CurrentTabs => ({ok: false, error: extensionView().error || "浏览器扩展未连接，无法读取标签列表"});
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
      const pendingSnapshot = scoped.readCurrentTabs!();
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
    streamHub: getStreamHub(),
    get proxyEnabled() { return proxyEnabled; },
    get providerName() { return providerName; },
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      const origin = request.headers.get("origin");
      // Widget pages are public on localhost so extension iframes can load them
      // as normal web documents (own JS context, not extension CSP).
      if (request.method === "GET" && url.pathname.startsWith("/widget/")) {
        const id = url.pathname.slice("/widget/".length);
        const page = readWidgetPage(dataDir, id);
        if (!page) return new Response("widget not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
        return new Response(page, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
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
      if (request.method === "POST" && url.pathname === "/widget") {
        let body: { html?: unknown } | null = null;
        try { body = await request.json() as { html?: unknown }; } catch { body = null; }
        const html = typeof body?.html === "string" ? body.html : "";
        const saved = saveWidgetHtml(dataDir, html);
        if ("error" in saved) return respond(saved, 400);
        return respond(saved);
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return respond({ ok: true, extension: extensionView() });
      }
      if ((request.method === "GET" && url.pathname === "/tool-request") || (request.method === "POST" && url.pathname === "/tool-result")) {
        const actualVersion = url.searchParams.get("executorVersion");
        const matches = actualVersion === expectedVersion;
        extension = { status: matches ? "ready" : "mismatch", expectedVersion, actualVersion, lastSeenAt: new Date().toISOString(), ...(!matches ? { error: executorMismatchMessage } : {}) };
        if (!matches) {
          for (const request of bridge.list()) {
            bridge.resolve(request.id, { ok: false, error: `executor_version_mismatch: ${executorMismatchMessage}` });
          }
          return respond({ ok: false, requests: [], executorVersion: expectedVersion, faultCode: "executor_version_mismatch", error: executorMismatchMessage }, 409);
        }
      }
      if (request.method === "GET" && url.pathname === "/tool-request") {
        return respond({ executorVersion: expectedVersion, requests: bridge.list() });
      }
      if (request.method === "POST" && url.pathname === "/tool-result") {
        const body = (await request.json()) as { id?: string; result?: BrowserResult };
        if (!body.id || !body.result) return respond({ ok: false, error: "缺 id 或 result" }, 400);
        if (!bridge.resolve(body.id, body.result)) return respond({ ok: false, error: "没有这个工具请求" }, 404);
        return respond({ ok: true });
      }
      // Batch entry for external scripts: enqueue browser tool calls on the same
      // in-memory bridge the extension already polls, so they run on real tabs.
      if (request.method === "POST" && url.pathname === "/browser-batch") {
        let body: { tasks?: unknown } | null = null;
        try { body = await request.json() as { tasks?: unknown }; } catch { body = null; }
        const tasks = Array.isArray(body?.tasks) ? body.tasks as unknown[] : [];
        if (!tasks.length) return respond({ ok: false, error: "tasks 不能为空" }, 400);
        if (tasks.length > 32) return respond({ ok: false, error: "单批最多 32 个任务" }, 400);
        const bad = tasks.findIndex((task) => {
          const t = task as { name?: unknown; input?: unknown } | null;
          if (!t || typeof t !== "object" || typeof t.name !== "string" || !t.name.trim()) return true;
          if (t.input === undefined) return false;
          return typeof t.input !== "object" || t.input === null || Array.isArray(t.input);
        });
        if (bad >= 0) return respond({ ok: false, error: `tasks[${bad}] 需要形如 { name: string, input?: object }` }, 400);
        const view = extensionView();
        if (view.status !== "ready") {
          return respond({ ok: false, error: view.error || "浏览器扩展未连接，无法批量执行浏览器任务", extension: view }, 503);
        }
        const batchHost = snapshotHost("external-batch");
        const results = await Promise.all(tasks.map(async (task, index) => {
          const t = task as { name: string; input?: Record<string, unknown> };
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const result = await Promise.race([
              batchHost.execute(t.name, t.input ?? {}),
              new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("批量任务超时")), 60_000); }),
            ]);
            return { index, name: t.name, result };
          } catch (error) {
            return { index, name: t.name, result: { ok: false, error: error instanceof Error ? error.message : String(error) } as BrowserResult };
          } finally { clearTimeout(timer!); }
        }));
        return respond({ ok: true, count: results.length, results });
      }
      if (request.method === "GET" && url.pathname === "/session") {
        const requested = url.searchParams.get("conversationId");
        return respond(currentSessionView(dataDir, requested));
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
        const nextApiKeyEnv = nextName ? providerApiKeyEnv[nextName] : undefined;
        if (nextName && nextName !== providerName && !(nextApiKeyEnv && Bun.env[nextApiKeyEnv]?.trim())) {
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
        if (!userInput) return respond({ conversationId: "", turnId: "", stopReason: { kind: "error", faultCode: "empty_input" } }, 400);
        if (body.conversationId && !listConversationIds(dataDir).includes(body.conversationId)) {
          return respond({ stopReason: { kind: "error", faultCode: "unknown_conversation" } }, 404);
        }
        const submittedAt = body.submittedAt || new Date().toISOString();
        const reply = await runTurnWithContinuation(deps, { userInput, submittedAt, conversationId: body.conversationId });
        return respond(reply);
      }
      if (request.method === "POST" && url.pathname === "/stop") {
        const raw = await request.text();
        const target = raw ? (JSON.parse(raw) as { conversationId?: string | null }).conversationId : undefined;
        const conversationId = target ?? loadSession(dataDir)?.conversationId;
        if (conversationId && !listConversationIds(dataDir).includes(conversationId)) {
          return respond({ error: "没有这个会话" }, 404);
        }
        const stopped = stopTurn(dataDir, conversationId);
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
  const hub = getStreamHub();
  Bun.serve({
    hostname,
    port,
    fetch: (request, bunServer) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/stream") {
        const origin = request.headers.get("origin");
        const hostOk = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
        const originOk = origin === null
          || /^chrome-extension:\/\/[a-p]{32}$/.test(origin)
          || origin === Bun.env.TCHROME_EXTENSION_ORIGIN;
        if (!hostOk || !originOk) return new Response("forbidden origin", { status: 403 });
        const upgraded = bunServer.upgrade(request);
        return upgraded ? undefined as unknown as Response : new Response("stream upgrade failed", { status: 400 });
      }
      return server.fetch(request);
    },
    websocket: {
      open(ws) {
        const send = (data: ArrayBuffer) => { try { ws.send(data); } catch { /* closed */ } };
        (ws as { streamSend?: typeof send }).streamSend = send;
        hub.attach(send);
      },
      message(ws, message) {
        const raw = typeof message === "string" ? new TextEncoder().encode(message) : message;
        hub.handleMessage(raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer));
      },
      close(ws) {
        const send = (ws as { streamSend?: (data: ArrayBuffer) => void }).streamSend;
        if (send) hub.detach(send);
      },
    },
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      cancelAllExecutions();
      abortAllLocalProcesses();
      process.exit(0);
    });
  }
  console.log(`Helm service http://${hostname}:${port}`);
  console.log(`Model connection: ${server.proxyEnabled ? "proxy" : "direct"}`);
  console.log(`Provider: ${server.providerName}`);
}
