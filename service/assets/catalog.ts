import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allocateRecordId, nowIso } from "../runtime/ids.ts";

export type AssetKind = "image" | "text" | "binary" | "dom";

export type AssetEntry = {
  assetId: string;
  name: string;
  kind: AssetKind;
  bytes: number;
  summary: string;
  createdAt: string;
  source: { tool?: string; callId?: string; pageId?: string };
  path: string;
};

const fileOf = (dataDir: string, conversationId: string) =>
  join(dataDir, "conversations", conversationId, "assets.json");

export function loadAssets(dataDir: string, conversationId: string): AssetEntry[] {
  const path = fileOf(dataDir, conversationId);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as AssetEntry[];
}

export function appendAsset(
  dataDir: string,
  conversationId: string,
  entry: Omit<AssetEntry, "assetId" | "createdAt"> & { createdAt?: string },
): AssetEntry {
  const list = loadAssets(dataDir, conversationId);
  const record: AssetEntry = {
    ...entry,
    assetId: allocateRecordId(dataDir, conversationId, "asset"),
    createdAt: entry.createdAt ?? nowIso(),
  };
  list.push(record);
  const path = fileOf(dataDir, conversationId);
  mkdirSync(join(dataDir, "conversations", conversationId), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(list, null, 2));
  renameSync(temporary, path);
  return record;
}

/** 粗分文本形态，决定摘要写法。 */
export function textFlavor(text: string): "code" | "json" | "prose" {
  const head = text.slice(0, 400);
  if (/^[\s]*[[{]/.test(head)) return "json";
  const codeMarks = (head.match(/(?:function |const |let |var |import |export |def |class |=>|<\/?[a-z]+>)/g) ?? []).length;
  if (codeMarks >= 2 || /^#!/.test(head) || /;\s*$/m.test(head.split("\n").slice(0, 5).join("\n"))) return "code";
  return "prose";
}

/** 文本摘要：按形态取标题/首句或代码签名。 */
export function textSummary(text: string): string {
  const flavor = textFlavor(text);
  if (flavor === "code") {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const signature = lines.find((line) => /^(?:#!|import |export |from |def |class |function |const |let |interface |type )/.test(line)) ?? lines[0] ?? "";
    return signature.slice(0, 120);
  }
  if (flavor === "json") {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) return `json[] ×${parsed.length}`;
      if (parsed && typeof parsed === "object") {
        const keys = Object.keys(parsed as Record<string, unknown>).slice(0, 6);
        return `json{${keys.join(",")}}`;
      }
    } catch { /* fall through to prose */ }
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const noise = /^[\s\p{P}\p{S}]+$/u;
  const meaningful = lines.filter((line) => !noise.test(line));
  const first = (meaningful[0] ?? "").replace(/^#+\s*/, "");
  const looksLikeTitle = first.length > 0 && first.length <= 40 && !/[。！？.!?；;]$/.test(first);
  const sentenceSource = looksLikeTitle ? meaningful.slice(1).join(" ") : meaningful.join(" ");
  const sentence = (sentenceSource.match(/[^。！？!?\n]+[。！？!?]?/) ?? [first])[0]!.trim();
  const body = looksLikeTitle && sentence ? `${first} · ${sentence}` : (sentence || first);
  return body.slice(0, 120);
}

/** 图片摘要：来源事实，不看图说话。 */
export function imageSummary(meta: {
  width: number;
  height: number;
  mime?: string;
  bytes: number;
  tool?: string;
  tabTitle?: string;
  url?: string;
  element?: string;
}): string {
  const parts = [`${meta.width}×${meta.height}`, meta.tool ?? "image"];
  if (meta.element) parts.push(meta.element);
  if (meta.tabTitle) parts.push(meta.tabTitle);
  else if (meta.url) {
    try { parts.push(new URL(meta.url).host); } catch { /* keep factual only */ }
  }
  parts.push(`${meta.bytes}B`);
  return parts.join(" · ");
}
