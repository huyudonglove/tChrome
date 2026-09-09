import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.ts";

for (const variable of ["HTTP_PROXY", "ALL_PROXY"]) {
  test(`server uses ${variable} for startup and subsequent proxy toggles`, async () => {
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
      expect(actual).toEqual(["http://127.0.0.1:19999", "http://127.0.0.1:19999"]);
    } finally {
      mock.mockRestore();
      for (const [key, value] of saved) { if (value === undefined) delete Bun.env[key]; else Bun.env[key] = value; }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
