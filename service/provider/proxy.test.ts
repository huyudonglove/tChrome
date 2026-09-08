import { expect, test } from "bun:test";
import { resolveProxy } from "./uuapi.ts";

test("直连开关覆盖已有代理", () => {
  expect(resolveProxy({ TCHROME_PROXY_MODE: "direct", HTTPS_PROXY: "http://localhost:7892" })).toBe("");
});
test("代理开关使用默认地址或指定地址", () => {
  expect(resolveProxy({ TCHROME_PROXY_MODE: "proxy", HTTPS_PROXY: "" })).toBe("http://127.0.0.1:7892");
  expect(resolveProxy({ TCHROME_PROXY_MODE: "proxy", HTTPS_PROXY: "http://localhost:7890" })).toBe("http://localhost:7890");
});
test("普通启动保留环境代理配置", () => {
  expect(resolveProxy({ HTTPS_PROXY: "http://localhost:7892" })).toBe("http://localhost:7892");
});
