import { runtimeConfig } from "./config/runtime.ts";
import type { ImageReference } from "./images/store.ts";

const LIST_FIELDS = ["results", "matches", "items", "regions", "elements", "windows", "frames", "entries", "blocks"] as const;

/** 嵌套列表路径（如 HAR 的 har.log.entries 在两层之下，顶层字段名抓不到）。 */
const NESTED_LIST_FIELDS = [["har", "log", "entries"], ["log", "entries"], ["result", "har", "log", "entries"]] as const;

/** 目录每行最少字数：低于此值标签会被截碎，目录反而不可读。 */
const MIN_INDEX_LINE_CHARS = 100;

/** 指针载荷里 totalChars/path/message 等固定字段的预留，目录只能在余量里生长。 */
const INDEX_OVERHEAD_RESERVE = 300;

/** 单行超过此字数就按此粒度切段：过长的单行会让按行索引退化成「只有文件名」。 */
const LONG_LINE_CHARS = 200;

/** 目录分层上限：L1 装不下就生成块目录（L2），块目录还装不下再生成一层（L3）。 */
const INDEX_LEVEL_CAP = 3;

/** 块目录里每行目标字数：决定一块收多少条标签。 */
const BLOCK_LABEL_CHARS = 200;

/** 命中关键词片段：grep 类结果带上 hit，目录里能直接看出「哪一行有我要的字」。 */
function hitSnippet(rec: Record<string, unknown>, max = 20): string {
  return typeof rec.hit === "string" ? ` "${rec.hit.slice(0, max)}"` : "";
}

/** 网络请求类条目（HAR entries）：没有 path/line，用 method + path + status 定位。 */
function requestLabel(rec: Record<string, unknown>): string | null {
  const request = rec.request;
  if (!request || typeof request !== "object") return null;
  const req = request as Record<string, unknown>;
  if (typeof req.url !== "string") return null;
  const bare = req.url.replace(/^https?:\/\/[^/]+/, "") || req.url;
  const method = typeof req.method === "string" ? req.method : "";
  const response = rec.response;
  const res = response && typeof response === "object" ? (response as Record<string, unknown>) : null;
  const status = res && typeof res.status === "number" ? res.status : 0;
  return `${method ? `${method} ` : ""}${bare.slice(0, 48)}${status ? ` ${status}` : ""}`;
}

/** 大文本条目（fs_read 的 content）按行展开成目录：单行超长的再按 LONG_LINE_CHARS 切段，带 .段号。 */
function expandLongContent(item: unknown): string[] {
  if (!item || typeof item !== "object") return [];
  const rec = item as Record<string, unknown>;
  const content = rec.content;
  if (typeof content !== "string" || content.length <= LONG_LINE_CHARS) return [];
  const base = typeof rec.path === "string" ? rec.path.split("/").pop() ?? rec.path : "content";
  const firstLine = typeof rec.startLine === "number" ? rec.startLine : 1;
  const labels: string[] = [];
  // 文件级区间标签保留（对外一直是 path:startLine-endLine/totalLines），后面再补逐行明细。
  if (typeof rec.path === "string" && typeof rec.startLine === "number") {
    const range = rec.endLine === rec.startLine ? `${rec.startLine}` : `${rec.startLine}-${rec.endLine}`;
    const total = typeof rec.totalLines === "number" ? `/${rec.totalLines}` : "";
    labels.push(`${base}:${range}${total}`);
  }
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = firstLine + i;
    // 按码点切，避免中文字符被 UTF-16 从中间劈成半个字符。
    const chars = Array.from(lines[i]);
    if (chars.length <= LONG_LINE_CHARS) {
      labels.push(`${base}:${lineNo}${hitSnippet({ hit: chars.join("") }, 40)}`);
      continue;
    }
    // 超长单行统一按 LONG_LINE_CHARS 切段并全量列出：拆行只负责把格式规范到同一粒度，
    // 装不下交给 L1/L2/L3 分层预算处理，目录内部不再另设截断上限。
    const segments = Math.ceil(chars.length / LONG_LINE_CHARS);
    for (let part = 1; part <= segments; part += 1) {
      const offset = (part - 1) * LONG_LINE_CHARS;
      labels.push(`${base}:${lineNo}.${part}${hitSnippet({ hit: chars.slice(offset, offset + LONG_LINE_CHARS).join("") }, 40)}`);
    }
  }
  return labels;
}

/** 单条结果的紧凑标签：按可定位性从高到低取（行号区间 / 命中行 → 请求 → id → 名称）。 */
function labelItem(item: unknown): string | null {
  if (typeof item === "string") return item.slice(0, 40);
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;
  if (typeof rec.path === "string") {
    const base = rec.path.split("/").pop() ?? rec.path;
    if (typeof rec.startLine === "number") {
      const range = rec.endLine === rec.startLine ? `${rec.startLine}` : `${rec.startLine}-${rec.endLine}`;
      const total = typeof rec.totalLines === "number" ? `/${rec.totalLines}` : "";
      return `${base}:${range}${total}`;
    }
    if (typeof rec.line === "number") return `${base}:${rec.line}${hitSnippet(rec)}`;
    return base;
  }
  if (typeof rec.line === "number") return `line ${rec.line}${hitSnippet(rec)}`;
  // 分块条目（fs_outline 的 blocks）：没有 path/line，只有块号与块内行号，用 preview 开头做线索。
  if (typeof rec.startLine === "number" && typeof rec.preview === "string") {
    const head = rec.preview.trim().replace(/\s+/g, " ").slice(0, 32);
    return `block${typeof rec.index === "number" ? rec.index : "?"} p.${rec.startLine}${head ? ` "${head}"` : ""}`;
  }
  const reqLabel = requestLabel(rec);
  if (reqLabel) return reqLabel;
  if (typeof rec.url === "string") return rec.url.replace(/^https?:\/\/[^/]+/, "").slice(0, 48) || rec.url;
  for (const field of ["id", "name", "label", "text"] as const) {
    const value = rec[field];
    if (typeof value === "string" && value) return value.slice(0, 40);
  }
  return null;
}

/** 索引聚类：同一条目的多处命中合并成 a.ts×12(1,7,42)，省地方且信息量更高。 */
function clusterLabels(labels: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const label of labels) {
    if (!label) continue;
    const colon = label.indexOf(":");
    const key = colon > 0 ? label.slice(0, colon) : label;
    const bucket = groups.get(key);
    if (bucket) bucket.push(label);
    else groups.set(key, [label]);
  }
  const out: string[] = [];
  for (const [key, items] of groups) {
    if (items.length <= 2) {
      out.push(...items);
      continue;
    }
    const rest = items.map((item) => item.slice(key.length + 1));
    out.push(`${key}×${items.length}(${rest.slice(0, 6).join(",")}${items.length > 6 ? ",…" : ""})`);
  }
  return out;
}

/** 疑似失败项（末尾 4xx/5xx）：目录里优先排前面。 */
function isProblemLabel(label: string): boolean {
  return /(?:^|\s)[45]\d\d$/.test(label);
}

/** 结构化摘要：从超限 JSON 里抽出可行动事实（路径、行号区间、条目数、错误码），供外置指针直接可读。无法解析出事实时返回空串，调用方回退原文切片。 */
/** 完整索引（不裁剪）：目录分层里 L1=内联摘要、L2=落盘全量，两者共用同一份标签来源。 */
export function payloadIndex(full: string): { head: string; labels: string[]; fullLabels: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(full);
  } catch {
    return { head: "", labels: [], fullLabels: [] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { head: "", labels: [], fullLabels: [] };
  const rec = parsed as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof rec.toolName === "string") parts.push(`tool=${rec.toolName}`);
  if (typeof rec.faultCode === "string") parts.push(`faultCode=${rec.faultCode}`);
  if (rec.ok === false) parts.push("ok=false");
  if (typeof rec.truncated === "boolean" && rec.truncated) parts.push("truncated=true");
  if (typeof rec.scannedFiles === "number") parts.push(`scannedFiles=${rec.scannedFiles}`);
  if (typeof rec.scannedEntries === "number") parts.push(`scannedEntries=${rec.scannedEntries}`);
  const counts: string[] = [];
  const indexLabels: string[] = [];
  // L2 落盘用：未聚类的原始标签，同文件命中全量列出。
  const fullLabels: string[] = [];
  const listSources: { label: string; value: unknown }[] = LIST_FIELDS.map((field) => ({ label: field, value: rec[field] }));
  for (const nested of NESTED_LIST_FIELDS) {
    let cursor: unknown = rec;
    for (const key of nested) cursor = cursor && typeof cursor === "object" ? (cursor as Record<string, unknown>)[key] : undefined;
    listSources.push({ label: nested.join("."), value: cursor });
  }
  for (const source of listSources) {
    if (!Array.isArray(source.value) || source.value.length === 0) continue;
    const expanded: string[] = [];
    const labels: string[] = [];
    for (const item of source.value) {
      // 大文本条目按行/按 LONG_LINE_CHARS 展开，逐行带线索，不做同 key 折叠。
      const lines = expandLongContent(item);
      if (lines.length) {
        expanded.push(...lines);
        continue;
      }
      const label = labelItem(item);
      if (label) labels.push(label);
    }
    counts.push(`${source.label}×${source.value.length}`);
    const unique = [...new Set(labels)];
    fullLabels.push(...(expanded.length ? expanded : unique));
    indexLabels.push(...(expanded.length ? expanded : clusterLabels(unique)));
  }
  // 疑似失败（4xx/5xx）前置：摘要预算有限时先看到有问题的条目。
  indexLabels.sort((a, b) => Number(isProblemLabel(b)) - Number(isProblemLabel(a)));
  if (typeof rec.message === "string") parts.push(`message=${rec.message.slice(0, 80)}`);
  if (!parts.length && !counts.length) return { head: "", labels: [], fullLabels: [] };
  // 计数段恒占头部，索引段用剩余预算逐条装填：摘要短时也能看到可定位事实。
  return {
    head: [...parts, ...(counts.length ? [`counts: ${counts.join(", ")}`] : [])].join("; "),
    labels: indexLabels,
    fullLabels: fullLabels.length ? fullLabels : indexLabels,
  };
}

/**
 * L1 目录装配：把全量标签装进门禁预算，装不下的记为 dropped。
 * 分层目录时这是第 1 级；仍装不下时 summarizePayload 会用块目录再生成一级。
 */
function fitSection(head: string, indexLabels: string[], budget: number, lines: number, level = ""): { text: string; included: number; dropped: string[] } {
  if (head.length >= budget) return { text: `${head.slice(0, Math.max(0, budget - 1))}…`, included: 0, dropped: [...indexLabels] };
  if (!indexLabels.length) return { text: level ? `${head}\n${level}` : head, included: 0, dropped: [] };
  // 层级标题：每层都带上覆盖范围，模型据此判断该继续看上层还是在明细里直接定位。
  const levelCost = level ? 32 : 0;
  // 行数随载荷走：16KB → 4 行、80KB → 20 行；再大则封顶在 budget / MIN_INDEX_LINE_CHARS 行。
  const maxLines = Math.max(1, Math.min(lines, Math.floor(budget / MIN_INDEX_LINE_CHARS)));
  // 目录正文能用的字数：扣掉头部与 index(N行) 标记，避免整条摘要顶穿门禁。
  const indexBudget = Math.max(MIN_INDEX_LINE_CHARS, budget - head.length - levelCost - 24);
  const perLine = Math.max(MIN_INDEX_LINE_CHARS, Math.floor(indexBudget / maxLines));
  // 标签是原子的：装不下就整条退回，绝不腰斩成半句话。退下的交给上层再生成一级块目录。
  const rows: string[] = [];
  const dropped: string[] = [];
  let used = 0;
  for (const label of indexLabels) {
    const separator = rows.length ? 2 : 0;
    if (used + separator + label.length > indexBudget) { dropped.push(label); continue; }
    const current = rows.length ? rows[rows.length - 1] : "";
    if (current && current.length + 2 + label.length > perLine) {
      rows.push(label);
      used += 2 + label.length;
      continue;
    }
    if (current) {
      rows[rows.length - 1] = `${current}, ${label}`;
      used += 2 + label.length;
      continue;
    }
    rows.push(label);
    used += label.length;
  }
  const included = indexLabels.length - dropped.length;
  if (!rows.length) return { text: head, included: 0, dropped: [...indexLabels] };
  // 短行并入相邻行：每行都要能读（≥ MIN_INDEX_LINE_CHARS），合并只搬运字数、不新增内容。
  const body = rows.filter(Boolean);
  for (let i = 0; i < body.length; ) {
    if (body[i]!.length >= MIN_INDEX_LINE_CHARS) { i += 1; continue; }
    if (i + 1 < body.length) {
      body[i + 1] = `${body[i]}, ${body[i + 1]}`;
      body.splice(i, 1);
      continue;
    }
    if (body.length > 1) {
      const tail = body.pop() as string;
      body[body.length - 1] = `${body[body.length - 1]}, ${tail}`;
      continue;
    }
    break;
  }
  // 层级行形如「L1明细(120/600条)」，直接告诉模型这一层覆盖了多少、还剩多少在上层。
  const levelTitle = level ? `${level}(${included}/${indexLabels.length}条)` : "";
  const pieces = [head, levelTitle].filter(Boolean);
  return { text: `${pieces.join("\n")}\nindex(${body.length}行):\n${body.join("\n")}`, included, dropped };
}

/** 块目录：把没装下的标签按连续区间再折一层，每行只给首尾标签，中间按需检索。 */
function blockDirectory(labels: string[]): string[] {
  if (!labels.length) return [];
  const avg = Math.max(1, Math.floor(labels.reduce((sum, label) => sum + label.length, 0) / labels.length));
  const size = Math.max(1, Math.floor(BLOCK_LABEL_CHARS / avg));
  const out: string[] = [];
  for (let start = 0; start < labels.length; start += size) {
    const chunk = labels.slice(start, start + size);
    const first = chunk[0]!;
    const last = chunk[chunk.length - 1]!;
    out.push(first === last ? `block${start / size} ${first}` : `block${start / size} ${first} … ${last}`);
  }
  return out;
}

/** 分层目录：L1 装全量明细；装不下就往上封装一级——L2 是 L1 全量标签的块目录，
 * L3 又是 L2 全量块的块目录，每层都覆盖下一层的全体而不是只收装不下的剩余。
 * 某一层一旦能整层装下，就用它实际占的额度反推 L1 能拿多少，两层始终同时在窗口里。 */
export function summarizePayload(full: string): string {
  const { head, labels } = payloadIndex(full);
  if (!head) return "";
  const gate = runtimeConfig.results.inlineChars;
  const total = Math.max(MIN_INDEX_LINE_CHARS, gate - INDEX_OVERHEAD_RESERVE);
  const lineCount = Math.max(1, Math.ceil(full.length / gate));
  const first = fitSection(head, labels, total, lineCount, "L1明细");
  if (!first.dropped.length) return first.text;
  let base = labels;
  for (let depth = 1; depth < INDEX_LEVEL_CAP; depth += 1) {
    const blocks = blockDirectory(base);
    // 折层后行数不降说明这层没信息增益，停下别做死循环。
    if (blocks.length >= base.length) break;
    const section = fitSection(`L${depth + 1}块目录(${blocks.length}块)`, blocks, total, blocks.length, `L${depth + 1}块目录`);
    if (section.dropped.length) {
      // 这一层也装不下：把它整体再往上一层封装，继续往上试。
      base = blocks;
      continue;
    }
    const l1 = fitSection(head, labels, total - section.text.length - 24, lineCount, "L1明细");
    return `${l1.text}\n${section.text}`;
  }
  return `${first.text}\n…(+${first.dropped.length})`;
}

/** 入窗门禁：超限载荷降级为摘要/指针，并带回告——要细节请更精准，取回再过同一门禁。 */
export function admitText(
  full: string,
  meta: { callId?: string; pageId?: string; path: string; name?: string; indexPath?: string },
): { mode: "inline"; text: string } | { mode: "preview"; payload: Record<string, unknown> } {
  const { inlineChars, previewChars, lineWidth, searchContextChars } = runtimeConfig.results;
  if (full.length <= inlineChars) return { mode: "inline", text: full };
  const totalLines = Math.ceil(full.length / lineWidth);
  const summary = summarizePayload(full);
  const structured = summary.length > 0;
  // 目录里实际存在的层：从 summary 里把 L1明细/L2块目录 这类层级行摘出来，模型一眼看到有哪些层可用。
  const levels = structured
    ? summary
        .split("\n")
        .filter((line) => /^L\d+(明细|块目录)/.test(line))
        .map((line) => line.replace(/^L(\d+).*/, "L$1"))
    : [];
  const locate = meta.pageId ? `pageId=${meta.pageId}` : `callId=${meta.callId ?? ""}`;
  return {
    mode: "preview",
    payload: {
      ok: true,
      externalized: true,
      ...(meta.callId ? { callId: meta.callId } : {}),
      ...(meta.pageId ? { pageId: meta.pageId } : {}),
      ...(meta.name ? { name: meta.name } : {}),
      totalChars: full.length,
      totalLines,
      lineWidth,
      ...(structured ? { summary } : {}),
      ...(levels.length ? { levels } : {}),
      // 目录可能接近门禁预算，preview 只放头部（counts 段），避免同一份字符串入窗两遍。
      preview: structured ? summary.split("\n")[0].slice(0, previewChars) : full.slice(0, previewChars),
      path: meta.path,
      ...(meta.indexPath ? { indexPath: meta.indexPath } : {}),
      message: structured
        ? `runtime: 内容超过 ${inlineChars} 字符，已降级为摘要指针（summary 为分层目录，含 ${levels.join("、") || "L1"}；每层行内自带「本层覆盖/总量」，直接在该层定位或再往上翻一层；preview 为首行；全文 ${totalLines} 行${meta.indexPath ? `；完整不截断索引已落盘 ${meta.indexPath}` : ""}）。要细节请更精准：evidence.search(windows=[{${locate},keyword|startLine}])，可一次带多个窗口；取回结果会再过同一门禁。`
        : `runtime: 内容超过 ${inlineChars} 字符，已降级为摘要指针（preview 前 ${previewChars} 字，全文 ${totalLines} 行）。要细节请更精准：evidence.search(windows=[{${locate},keyword|startLine}])，可一次带多个窗口；取回结果会再过同一门禁。`,
      search: "evidence.search",
    },
  };
}

/** 图片门禁：小图随批附带像素；过大只保留元数据。 */
export function admitImages<T extends Pick<ImageReference, "bytes">>(images: T[]): { inline: T[]; deferred: T[] } {
  const limit = runtimeConfig.results.imageInlineBytes;
  const inline: T[] = [];
  const deferred: T[] = [];
  for (const image of images) (image.bytes <= limit ? inline : deferred).push(image);
  return { inline, deferred };
}

/** 单图门禁：小图 inline，大图 ref 并给出精准取用提示。 */
export function admitImage(image: ImageReference): { mode: "inline" | "ref"; fetchHint: string } {
  const { inline } = admitImages([image]);
  if (inline.length) return { mode: "inline", fetchHint: "" };
  return {
    mode: "ref",
    fetchHint: "信息已降级。要细节请更精准：image.crop 裁更小矩形，或 capture_page(mode=element|rect)；取回结果仍会经过同一门禁。",
  };
}

export function deferredImageNote(deferred: Pick<ImageReference, "id" | "path" | "width" | "height" | "bytes">[]): string {
  if (!deferred.length) return "";
  const rows = deferred.map((image) => `${image.id} ${image.width}x${image.height} ${image.bytes}B`).join(", ");
  return `runtime: 图片超过入窗门槛未附带像素（${rows}）。要画面请更精准：image.crop 或 capture_page(mode=element|rect) 只取目标区域；取回结果会再过同一门禁。`;
}
