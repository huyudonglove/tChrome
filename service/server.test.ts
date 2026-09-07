import { expect, test } from "bun:test";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.ts";

const base = "http://127.0.0.1:18788";
const extensionOrigin = `chrome-extension://${"a".repeat(32)}`;

test("外部网页在路由执行前被拒绝，包括简单 POST 和预检", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-origin-"));
  try {
    const server = createServer({ dataDir: dir, extensionOrigin });
    for (const method of ["GET", "POST", "OPTIONS"]) {
      const response = await server.fetch(new Request(`${base}/conversations/new`, {
        method, headers: { origin: "https://untrusted.example" },
      }));
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(existsSync(join(dir, "session.json"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("指定扩展允许预检和请求，其他扩展和 null origin 被拒绝", async () => {
  const server = createServer({ extensionOrigin });
  for (const method of ["GET", "OPTIONS"]) {
    const response = await server.fetch(new Request(`${base}/health`, {
      method, headers: { origin: extensionOrigin },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(extensionOrigin);
    expect(response.headers.get("vary")).toBe("Origin");
  }
  for (const origin of ["null", `chrome-extension://${"b".repeat(32)}`]) {
    expect((await server.fetch(new Request(`${base}/health`, { headers: { origin } }))).status).toBe(403);
  }
});

test("拒绝 DNS 重绑定地址和无 Origin 跨站请求，保留本机客户端", async () => {
  const server = createServer();
  expect((await server.fetch(new Request("http://rebind.example:18788/health"))).status).toBe(403);
  for (const site of ["cross-site", "same-site"]) {
    expect((await server.fetch(new Request(`${base}/health`, {
      headers: { "sec-fetch-site": site },
    }))).status).toBe(403);
  }
  expect((await server.fetch(new Request(`${base}/health`))).status).toBe(200);
});
