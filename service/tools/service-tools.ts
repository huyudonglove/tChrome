import { promises as dns } from "node:dns";
import tls from "node:tls";
import { runAccountVault } from "./account-vault.ts";

export const SERVICE_TOOL_NAMES = [
  "send_http",
  "send_http_batch",
  "api_discover",
  "api_execute",
  "api_manage",
  "web_search",
  "web_search_free",
  "deep_search",
  "search_plus",
  "osint_intel",
  "ping_url",
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

const fetchText = async (url: string, init: RequestInit = {}) => {
  const started = Date.now();
  const response = await fetch(url, { redirect: "follow", ...init });
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    ms: Date.now() - started,
    headers: Object.fromEntries([...response.headers.entries()].slice(0, 20)),
    text: text.slice(0, 8000),
  };
};

export async function runServiceTool(
  dataDir: string,
  name: string,
  input: Record<string, unknown> = {},
) {
  if (name === "account_vault") return runAccountVault(dataDir, input);
  if (name === "api_discover" || name === "api_manage") {
    return { ok: true, operations: [] };
  }
  if (name === "send_http" || name === "api_execute") {
    if (!input.url) return { ok: false, error: "缺 url" };
    return fetchText(String(input.url), {
      method: String(input.method || "GET"),
      headers: input.headers as HeadersInit | undefined,
      body: input.body == null ? undefined : String(input.body),
    });
  }
  if (name === "send_http_batch") {
    const urls = Array.isArray(input.urls) ? input.urls.map(String) : [];
    const results = [];
    for (const url of urls.slice(0, 5)) results.push(await fetchText(url));
    return { ok: true, results };
  }
  if (
    name === "web_search"
    || name === "web_search_free"
    || name === "deep_search"
    || name === "search_plus"
    || name === "osint_intel"
  ) {
    const query = input.query || input.q || input.text;
    if (!query) return { ok: false, error: "缺 query" };
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(String(query))}`;
    const page = await fetchText(url);
    const hits = [...page.text.matchAll(/uddg=([^&"]+)/g)].slice(0, 8).map((item) => decodeURIComponent(item[1] ?? ""));
    return { ok: true, query, urls: [...new Set(hits)] };
  }
  if (name === "ping_url") {
    const url = String(input.url || "https://www.gstatic.com/generate_204");
    try {
      const page = await fetchText(url, { method: "GET" });
      return { ok: true, reachable: page.status > 0, status: page.status, ms: page.ms, url: page.url };
    } catch (error) {
      return { ok: false, reachable: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (name === "probe_http") {
    if (!input.url) return { ok: false, error: "缺 url" };
    return fetchText(String(input.url), { method: String(input.method || "GET") });
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
