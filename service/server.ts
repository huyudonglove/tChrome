import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { handleTurn, type LoopDeps } from "./runtime/loop.ts";
import { createProvider } from "./provider/uuapi.ts";
import { defaultDataDir } from "./runtime/store.ts";

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
  const deps: LoopDeps = { dataDir, repoRoot, provider };
  return {
    dataDir,
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
      if (request.method === "POST" && url.pathname === "/turn") {
        const body = (await request.json()) as { userInput?: string; submittedAt?: string };
        const userInput = String(body.userInput ?? "").trim();
        if (!userInput) return json({ conversationId: "", turnId: "", output: { kind: "error", faultCode: "empty_input" } }, 400);
        const submittedAt = body.submittedAt || new Date().toISOString();
        const reply = await handleTurn(deps, { userInput, submittedAt });
        return json(reply);
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
