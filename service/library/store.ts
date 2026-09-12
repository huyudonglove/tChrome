import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { idPrefix } from "../identity/catalog.ts";

export type LibraryItem = {
  id: string;
  type: "website" | "account" | "note";
  title: string;
  url: string;
  username: string;
  password: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export class LibraryError extends Error {
  constructor(message: string, public status: 400 | 404 = 400) { super(message); }
}

type LibraryStore = { nextId: number; items: LibraryItem[] };
const prefix = () => idPrefix("library");
const validId = (id: unknown): id is string => typeof id === "string" && id.startsWith(prefix()) && /^\d+$/.test(id.slice(prefix().length));
const pathOf = (dataDir: string) => join(dataDir, "library", "items.json");
function read(dataDir: string): LibraryStore {
  const path = pathOf(dataDir);
  if (!existsSync(path)) return { nextId: 1, items: [] };
  const value = JSON.parse(readFileSync(path, "utf8")) as LibraryStore;
  if (!Number.isSafeInteger(value.nextId) || value.nextId < 1 || !Array.isArray(value.items)) {
    throw new Error("本地资料库格式损坏，无法读取");
  }
  return value;
}
function write(dataDir: string, store: LibraryStore) {
  mkdirSync(join(dataDir, "library"), { recursive: true });
  const path = pathOf(dataDir);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(store, null, 2), { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function listItems(dataDir: string, query = ""): LibraryItem[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return read(dataDir).items.filter(item => {
    const haystack = [item.id, item.type, item.title, item.url, item.username, item.password, item.content, ...item.tags].join("\n").toLocaleLowerCase();
    return terms.every(term => haystack.includes(term));
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || Number(b.id.slice(prefix().length)) - Number(a.id.slice(prefix().length)));
}

export function saveItem(dataDir: string, input: unknown): LibraryItem {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new LibraryError("资料必须是对象");
  const fields = input as Record<string, unknown>;
  const allowed = new Set(["id", "type", "title", "url", "username", "password", "content", "tags"]);
  for (const key of Object.keys(fields)) if (!allowed.has(key)) throw new LibraryError(`不支持的资料字段：${key}`);
  if ("id" in fields && !validId(fields.id)) throw new LibraryError(`id 必须是资料条目的 ${prefix()} 编号`);
  for (const key of ["title", "url", "username", "password", "content"] as const) {
    if (key in fields && typeof fields[key] !== "string") throw new LibraryError(`${key} 必须是文本`);
  }
  if ("type" in fields && !["website", "account", "note"].includes(fields.type as string)) throw new LibraryError("type 必须是 website、account 或 note");
  if ("tags" in fields && (!Array.isArray(fields.tags) || fields.tags.some(tag => typeof tag !== "string"))) throw new LibraryError("tags 必须是文本数组");
  const store = read(dataDir);
  const previous = fields.id === undefined ? undefined : store.items.find(item => item.id === fields.id);
  if (fields.id !== undefined && !previous) throw new LibraryError("未找到该资料条目", 404);
  const now = new Date().toISOString();
  const item: LibraryItem = {
    id: previous?.id ?? `${prefix()}${String(store.nextId).padStart(2, "0")}`,
    type: (fields.type ?? previous?.type) as LibraryItem["type"],
    title: ((fields.title ?? previous?.title ?? "") as string).trim(),
    url: ((fields.url ?? previous?.url ?? "") as string).trim(),
    username: (fields.username ?? previous?.username ?? "") as string,
    password: (fields.password ?? previous?.password ?? "") as string,
    content: (fields.content ?? previous?.content ?? "") as string,
    tags: fields.tags === undefined ? previous?.tags ?? [] : [...new Set((fields.tags as string[]).map(tag => tag.trim()).filter(Boolean))],
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  if (!item.type) throw new LibraryError("缺少资料类型 type");
  if (!item.title) throw new LibraryError("资料标题不能为空");
  if (item.url) {
    let valid = false;
    try { valid = ["http:", "https:"].includes(new URL(item.url).protocol); } catch {}
    if (!valid) throw new LibraryError("网址必须是完整的 http 或 https 地址");
  }
  if (item.type === "website" && !item.url) throw new LibraryError("网站资料需要填写网址");
  if (previous) store.items[store.items.indexOf(previous)] = item;
  else { store.nextId += 1; store.items.push(item); }
  write(dataDir, store);
  return item;
}

export function deleteItem(dataDir: string, id: string): void {
  if (!validId(id)) throw new LibraryError(`id 必须是资料条目的 ${prefix()} 编号`);
  const store = read(dataDir);
  const index = store.items.findIndex(item => item.id === id);
  if (index === -1) throw new LibraryError("未找到该资料条目", 404);
  store.items.splice(index, 1);
  write(dataDir, store);
}
