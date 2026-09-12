import { promises as dns } from "node:dns";
import tls from "node:tls";
import { runAccountVault } from "./account-vault.ts";
import { runTavilySearch } from "./tavily-search.ts";

export const SERVICE_TOOL_NAMES = [
  "send_http",
  "send_http_batch",
  "web_search",
  "tavily_search",
  "probe_http",
  "probe_dns",
  "probe_ssl",
  "account_vault",
] as const;

const hostOf = (input: Record<string, unknown>) => {
  if (input.host) return String(input.host);
  if (!input.url) return "";
  try {
    return new URL(String(input.url)).hostname;
  } catch {
    return "";
  }
};

const httpAddressError = (value: unknown): string | null => {
  if (typeof value !== "string" || !/^https?:\/\/\S+$/.test(value)) {
    return "url 必须是以 http:// 或 https:// 开头的完整链接地址字符串";
  }
  try { if (!new URL(value).hostname) throw new Error("missing host"); }
  catch { return "url 不是有效的 HTTP/HTTPS 链接地址"; }
  return null;
};

const fetchText = async (url: string, init: RequestInit = {}, textLimit = 8000) => {
  const started = Date.now();
  const response = await fetch(url, { redirect: "follow", ...init });
  const text = textLimit === 0 ? "" : await response.text();
  if (textLimit === 0) void response.body?.cancel().catch(() => {});
  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    ms: Date.now() - started,
    headers: Object.fromEntries([...response.headers.entries()].slice(0, 20)),
    text: text.slice(0, textLimit),
  };
};

export async function runServiceTool(
  dataDir: string,
  name: string,
  input: Record<string, unknown> = {},
) {
  if (name === "account_vault") return runAccountVault(dataDir, input);
  if (name === "tavily_search") return runTavilySearch(input);
  if (name === "send_http") {
    const error = httpAddressError(input.url);
    if (error) return { ok: false, error };
    return fetchText(input.url as string, {
      method: String(input.method || "GET"),
      headers: input.headers as HeadersInit | undefined,
      body: input.body == null ? undefined : String(input.body),
    });
  }
  if (name === "send_http_batch") {
    if (!Array.isArray(input.urls) || input.urls.length < 1 || input.urls.length > 5) {
      return { ok: false, error: "urls 必须是包含 1 至 5 个 HTTP/HTTPS 链接地址的数组", results: [] };
    }
    for (const [index, url] of input.urls.entries()) {
      const error = httpAddressError(url);
      if (error) return { ok: false, error: `urls[${index}]: ${error}`, results: [] };
    }
    const results = [];
    for (const url of input.urls as string[]) {
      try { results.push(await fetchText(url)); }
      catch (error) { results.push({ ok: false, url, error: error instanceof Error ? error.message : String(error) }); }
    }
    return { ok: results.every(result => result.ok), results };
  }
  if (name === "web_search") {
    const query = input.query || input.q || input.text;
    if (!query) return { ok: false, error: "缺 query" };
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(String(query))}`;
    try {
      // Parse the complete HTML before limiting the extracted result count.
      const page = await fetchText(url, {}, Infinity);
      if (!page.ok) return { ok: false, query, status: page.status, error: `搜索服务返回 HTTP ${page.status}`, urls: [] };
      const hits = new Set<string>();
      for (const item of page.text.matchAll(/uddg=([^&"'<>\s]+)/g)) {
        try {
          const target = decodeURIComponent(item[1] ?? "");
          if (["http:", "https:"].includes(new URL(target).protocol)) hits.add(target);
        } catch { /* A malformed result must not discard the other hits. */ }
        if (hits.size === 8) break;
      }
      return { ok: true, query, urls: [...hits] };
    } catch (error) {
      return { ok: false, query, error: error instanceof Error ? error.message : String(error), urls: [] };
    }
  }
  if (name === "probe_http") {
    if (typeof input.url !== "string" || !input.url.trim()) return { ok: false, error: "缺 url" };
    const url = input.url.trim();
    try {
      if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error();
    } catch {
      return { ok: false, error: "url 必须是有效的 HTTP 或 HTTPS 网址" };
    }
    const method = input.method === undefined ? "GET" : input.method;
    if (method !== "GET" && method !== "HEAD") return { ok: false, error: "method 仅支持 GET 或 HEAD" };
    const started = Date.now();
    try {
      const page = await fetchText(url, { method }, 0);
      return { ok: page.ok, reachable: true, status: page.status, ms: page.ms, url: page.url, headers: page.headers };
    } catch (error) {
      return { ok: false, reachable: false, url, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (name === "probe_dns") {
    const host = hostOf(input);
    if (!host) return { ok: false, error: "缺 host" };
    const addresses = await dns.lookup(host, { all: true });
    return { ok: true, host, addresses: addresses.map((item) => item.address) };
  }
  if (name === "probe_ssl") {
    const host = hostOf(input);
    if (!host) return { ok: false, error: "缺 host" };
    const port = Number(input.port) || 443;
    const cert = await new Promise<tls.PeerCertificate>((resolve, reject) => {
      const socket = tls.connect({ host, port, servername: host, timeout: 8000 }, () => {
        const peer = socket.getPeerCertificate();
        socket.end();
        resolve(peer);
      });
      socket.on("error", reject);
      socket.on("timeout", () => {
        socket.destroy();
        reject(new Error("tls timeout"));
      });
    });
    return {
      ok: true,
      host,
      valid: Boolean(cert?.valid_to),
      issuer: cert?.issuer?.O || cert?.issuer?.CN || "",
      validTo: cert?.valid_to || "",
      subject: cert?.subject?.CN || "",
    };
  }
  return { ok: false, error: `未接执行器 ${name}` };
}
