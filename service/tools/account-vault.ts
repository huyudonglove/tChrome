import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { nowIso } from "../runtime/ids.ts";

type Account = {
  id: string;
  site: string;
  username: string;
  password: string;
  label: string;
  note: string;
  createdAt: string;
  updatedAt: string;
};

const vaultPath = (dataDir: string) => join(dataDir, "accounts.json");

const readAccounts = (dataDir: string): Account[] => {
  const path = vaultPath(dataDir);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as Account[];
};

const writeAccounts = (dataDir: string, accounts: Account[]) => {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(vaultPath(dataDir), `${JSON.stringify(accounts, null, 2)}\n`, { mode: 0o600 });
};

const publicAccount = (item: Account, reveal = false) => ({
  id: item.id,
  site: item.site,
  username: item.username,
  label: item.label || "",
  note: item.note || "",
  password: reveal ? item.password : "••••••••",
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
});

const normalizeSite = (site: unknown) => {
  const raw = String(site || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    return raw;
  }
};

export function runAccountVault(dataDir: string, input: Record<string, unknown> = {}) {
  const action = String(input.action || "list");
  if (action === "save") {
    const normalizedSite = normalizeSite(input.site);
    if (!normalizedSite) return { ok: false, error: "账号库缺 site" };
    if (!String(input.username || "").trim()) return { ok: false, error: "账号库缺 username" };
    if (!String(input.password || "")) return { ok: false, error: "账号库缺 password" };
    const accounts = readAccounts(dataDir);
    const found = accounts.find((item) =>
      (input.id && item.id === input.id)
      || (item.site === normalizedSite && item.username === String(input.username).trim()),
    );
    const stamp = nowIso();
    if (found) {
      found.password = String(input.password);
      found.label = String(input.label || found.label || "");
      found.note = String(input.note || found.note || "");
      found.updatedAt = stamp;
      writeAccounts(dataDir, accounts);
      return { ok: true, account: publicAccount(found, true) };
    }
    const item: Account = {
      id: `account-${randomUUID()}`,
      site: normalizedSite,
      username: String(input.username).trim(),
      password: String(input.password),
      label: String(input.label || ""),
      note: String(input.note || ""),
      createdAt: stamp,
      updatedAt: stamp,
    };
    accounts.unshift(item);
    writeAccounts(dataDir, accounts);
    return { ok: true, account: publicAccount(item, true) };
  }
  if (action === "get") {
    const wantedSite = normalizeSite(input.site);
    const item = readAccounts(dataDir).find((candidate) =>
      (input.id && candidate.id === input.id)
      || (wantedSite && candidate.site === wantedSite && (!input.username || candidate.username === input.username)),
    );
    return item ? { ok: true, account: publicAccount(item, true) } : { ok: false, error: "没有匹配的账号" };
  }
  if (action === "delete") {
    const id = String(input.id || "");
    if (!id) return { ok: false, error: "账号库缺 id" };
    const accounts = readAccounts(dataDir);
    if (!accounts.some((item) => item.id === id)) return { ok: false, error: "没有这个账号" };
    writeAccounts(dataDir, accounts.filter((item) => item.id !== id));
    return { ok: true };
  }
  const wanted = normalizeSite(input.site);
  return {
    ok: true,
    items: readAccounts(dataDir)
      .filter((item) => !wanted || item.site === wanted)
      .map((item) => publicAccount(item, input.reveal === true)),
  };
}
