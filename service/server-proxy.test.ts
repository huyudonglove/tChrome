import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.ts";

for (const variable of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"]) {
  test(`server starts direct despite ${variable} and uses it only after enabling proxy`, async () => {
    const keys = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "TCHROME_PROXY_MODE", "UUAPI_API_KEY"];
    const saved = keys.map(key => [key, Bun.env[key]] as const);
    const dir = mkdtempSync(join(tmpdir(), "tchrome-server-proxy-"));
    const actual: unknown[] = [];
    const mock = spyOn(globalThis, "fetch").mockImplementation((async (_url: RequestInfo | URL, init?: RequestInit) => {
      actual.push((init as RequestInit & { proxy?: string })?.proxy);
      return Response.json({ id: "local-test", choices: [{ index: 0, finish_reason: "tool_calls", message: {
        role: "assistant", content: "", tool_calls: [{ id: "finish", type: "function", function: {
          name: "finishTurn", arguments: JSON.stringify({ reason: "已完成", affectsPage: false, text: "完成" }),
        } }],
      } }] });
    }) as typeof fetch);
    try {
      for (const key of keys) delete Bun.env[key];
      Bun.env[variable] = "http://127.0.0.1:19999";
      Bun.env.UUAPI_API_KEY = "local-test-not-a-secret";
      const server = createServer({ dataDir: dir, repoRoot: join(import.meta.dir, "..") });
      const request = (path: string, body: unknown) => server.fetch(new Request(`http://127.0.0.1:18788${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }));
      await request("/turn", { userInput: "你好" });
      await request("/connection", { enabled: false });
      await request("/connection", { enabled: true });
      await request("/turn", { userInput: "再见" });
      expect(actual).toEqual([undefined, "http://127.0.0.1:19999"]);
      expect(server.proxyEnabled).toBe(true);
      const restarted = createServer({ dataDir: dir });
      expect(restarted.proxyEnabled).toBe(true);
      await request("/connection", { enabled: false });
      await request("/turn", { userInput: "直连再试" });
      expect(actual).toEqual([undefined, "http://127.0.0.1:19999", undefined]);
      expect(server.proxyEnabled).toBe(false);
      expect(createServer({ dataDir: dir }).proxyEnabled).toBe(false);
    } finally {
      mock.mockRestore();
      for (const [key, value] of saved) { if (value === undefined) delete Bun.env[key]; else Bun.env[key] = value; }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const [mode, stored, expected] of [
  [undefined, undefined, false],
  ["direct", undefined, false],
  ["proxy", undefined, true],
  ["proxy", false, false],
  ["direct", true, true],
  [undefined, true, true],
] as const) {
  test(`connection initialization mode=${mode} saved=${stored} yields enabled=${expected}`, async () => {
    const savedMode = Bun.env.TCHROME_PROXY_MODE;
    const dir = mkdtempSync(join(tmpdir(), "tchrome-connection-default-"));
    try {
      if (mode === undefined) delete Bun.env.TCHROME_PROXY_MODE;
      else Bun.env.TCHROME_PROXY_MODE = mode;
      if (stored !== undefined) writeFileSync(join(dir, "connection.json"), JSON.stringify({ enabled: stored }));
      const server = createServer({ dataDir: dir });
      const status = await (await server.fetch(new Request("http://127.0.0.1:18788/connection"))).json();
      expect(status).toEqual({ enabled: expected });
      expect(server.proxyEnabled).toBe(expected);
    } finally {
      if (savedMode === undefined) delete Bun.env.TCHROME_PROXY_MODE;
      else Bun.env.TCHROME_PROXY_MODE = savedMode;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
