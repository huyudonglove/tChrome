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

/** 指针里 layers 最多列多少个可寻址块 id：够定位即可，再多就该去读 index.json。 */
const LAYER_CHUNK_CAP = 40;

/** 检索取回的窗口上限：不另设门禁，统一按入窗门禁扣掉指针壳计算。 */
export const retrievalWindowChars = (): number =>
  Math.max(
    MIN_INDEX_LINE_CHARS,
    runtimeConfig.results.inlineChars - runtimeConfig.results.pointerShellReserve,
  );

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
    const chars = Array.from(lines[i] ?? "");
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

/** 单条结果的紧凑标签：按可定位性从高到低取（行号区间 / 命中行 → 请求 → id → 名称）。
 * parentPath 是祖先节点上的文件路径：evidence_search 这类载荷把 path 放在外层 results[]、
 * 行号与命中词放在内层 matches[]，只看本项会丢掉定位信息，故由调用方下钻时带下来。 */
function labelItem(item: unknown, parentPath = ""): string | null {
  if (typeof item === "string") return item.slice(0, 40);
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;
  const own = typeof rec.path === "string" ? rec.path : parentPath;
  const base = own ? own.split("/").pop() ?? own : "";
  if (own && typeof rec.startLine === "number") {
    const range = rec.endLine === rec.startLine ? `${rec.startLine}` : `${rec.startLine}-${rec.endLine}`;
    const total = typeof rec.totalLines === "number" ? `/${rec.totalLines}` : "";
    return `${base}:${range}${total}`;
  }
  // 内层条目（evidence_search 的 matches 元素）把行号放在 lineStart，path 只挂在外层 results[] 上，
  // 故行号也接受 lineStart，并在有祖先路径时带上它，才定位得到具体哪一行。
  const lineNo = typeof rec.line === "number" ? rec.line : typeof rec.lineStart === "number" ? rec.lineStart : null;
  if (lineNo !== null) return base ? `${base}:${lineNo}${hitSnippet(rec)}` : `line ${lineNo}${hitSnippet(rec)}`;
  if (own) return base;
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

/** 标签是否只到「文件名」这一层：只有 path 没有行号时，多半还有内层可定位信息。 */
function bareFileLabel(item: unknown, label: string): boolean {
  if (!item || typeof item !== "object") return false;
  const rec = item as Record<string, unknown>;
  if (typeof rec.path !== "string") return false;
  return label === (rec.path.split("/").pop() ?? rec.path);
}

/** 内层条目标签：外层给 path、内层给 lineStart/hit 时，继承祖先路径拼成 base:line "hit"。
 * 深度与条数都有上限：只补「外层标签只到文件名」的场景，不整体展开大对象。 */
function nestedLabels(item: unknown, parentPath: string, depth = 1, cap = 60): string[] {
  if (depth > 3 || !item || typeof item !== "object") return [];
  const out: string[] = [];
  const visit = (child: unknown) => {
    if (out.length >= cap || !child || typeof child !== "object") return;
    const label = labelItem(child, parentPath);
    // 只收比「只有文件名」更具体的标签，泛泛的 id/name 不占目录预算。
    if (label && !bareFileLabel(child, label)) out.push(label);
    out.push(...nestedLabels(child, parentPath, depth + 1, cap - out.length));
  };
  for (const value of Object.values(item as Record<string, unknown>)) {
    if (out.length >= cap) break;
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") visit(value);
  }
  return out;
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
      // 标签只到文件名时往内层再走一步：evidence_search 这类载荷把 path 放外层、
      // 行号与命中词放 matches[]，只看本项会退化成「只有文件名」。
      if (label && bareFileLabel(item, label)) {
        const parentPath = (item as Record<string, unknown>).path as string;
        labels.push(...nestedLabels(item, parentPath, 1, Math.max(8, Math.floor(200 / source.value.length))));
      }
    }
    counts.push(`${source.label}×${source.value.length}`);
    const unique = [...new Set(labels)];
    fullLabels.push(...(expanded.length ? expanded : unique));
    indexLabels.push(...(expanded.length ? expanded : clusterLabels(unique)));
  }
  // 疑似失败（4xx/5xx）前置：摘要预算有限时先看到有问题的条目。L1 走全量标签，同样要前置。
  const byProblemFirst = (a: string, b: string) => Number(isProblemLabel(b)) - Number(isProblemLabel(a));
  indexLabels.sort(byProblemFirst);
  fullLabels.sort(byProblemFirst);
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

/** 一级目录行：标签原子保留（不腰斩），短行并入相邻行到可读长度。 */
function packRows(labels: string[]): string[] {
  const rows: string[] = [];
  let current = "";
  for (const label of labels) {
    if (!current) {
      current = label;
      continue;
    }
    if (current.length + 2 + label.length <= BLOCK_LABEL_CHARS) {
      current = `${current}, ${label}`;
      continue;
    }
    rows.push(current);
    current = label;
  }
  if (current) rows.push(current);
  const merged: string[] = [];
  for (const row of rows) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && prev.length < MIN_INDEX_LINE_CHARS) {
      merged[merged.length - 1] = `${prev}, ${row}`;
      continue;
    }
    merged.push(row);
  }
  return merged;
}

/** 分层索引的一块：独立可寻址单元，正文自身不超门禁，from/to 指向下一层的行区间。 */
export type LevelChunk = { id: string; from: number; to: number; chars: number; text: string };
export type IndexLevel = { id: string; name: string; total: number; chunks: LevelChunk[] };
export type IndexTree = { head: string; levels: IndexLevel[] };

/** 把若干行切成若干块：每块 ≤ budget，id 形如 L1.1，可单独寻址。 */
function chunkRows(rows: string[], prefix: string, budget: number): LevelChunk[] {
  const chunks: LevelChunk[] = [];
  let buffer: string[] = [];
  let start = 0;
  let used = 0;
  const flush = (end: number) => {
    if (!buffer.length) return;
    chunks.push({ id: `${prefix}.${chunks.length + 1}`, from: start + 1, to: end + 1, chars: used, text: buffer.join("\n") });
    buffer = [];
    used = 0;
  };
  for (let i = 0; i < rows.length; i += 1) {
    const add = buffer.length ? 1 + rows[i]!.length : rows[i]!.length;
    if (buffer.length && used + add > budget) {
      flush(i - 1);
      start = i;
    }
    buffer.push(rows[i]!);
    used += add;
  }
  flush(rows.length - 1);
  return chunks;
}

/** 每层的块预算：L1 是明细占大头，上层封装按目录体量给小份额，两层才能同处一窗。 */
function levelBudget(id: string, budget: number): number {
  return Math.max(MIN_INDEX_LINE_CHARS, id === "L1" ? Math.floor(budget * 0.6) : Math.floor(budget * 0.3));
}

/** 从一块正文里取前一半（按整行截断，不切碎行），超预算时只留前若干行。 */
function headHalf(text: string, cap: number): string {
  const rows = text.split("\n");
  const mid = Math.max(1, Math.ceil(rows.length / 2));
  const out: string[] = [];
  let used = 0;
  for (const row of rows.slice(0, mid)) {
    const add = out.length ? 1 + row.length : row.length;
    // 单行就超 cap（上层块整行只有一条）时按字符截断，否则父块会突破门禁。
    if (add > cap) {
      if (!out.length) out.push(`${row.slice(0, Math.max(1, cap - 1))}…`);
      break;
    }
    if (out.length && used + add > cap) break;
    out.push(row);
    used += add;
  }
  return out.join(" ⏎ ");
}

/** 分层索引树（严格二分金字塔）：L1 是全量标签明细；L(n+1) 的每一块由两个 Ln 块各取一半正文拼成，
 * 于是块数逐层减半（L1 8 块 → L2 4 块 → L3 2 块），每层都是完整可独立寻址的一份，
 * 而不是「上一层没装下的剩余」，也不是把下层标签整段抄一遍。
 * 块正文里的 ⏎ 是被折叠的行边界，只作阅读提示，不影响按 id 取回原文。 */
export function buildLevels(head: string, labels: string[]): IndexTree {
  const budget = Math.max(MIN_INDEX_LINE_CHARS, runtimeConfig.results.inlineChars - INDEX_OVERHEAD_RESERVE);
  const levels: IndexLevel[] = [];
  const l1Chunks = chunkRows(packRows(labels), "L1", levelBudget("L1", budget));
  levels.push({ id: "L1", name: "L1明细", total: labels.length, chunks: l1Chunks });
  // 每个子块只取「该层单块预算的一半」，两个子块拼成的父块才真是上一层的一半，
  // 于是 L1 8 块 → L2 4 块 → L3 2 块逐层减半，而不是把块越折越胖。
  const halfCap = Math.max(80, Math.floor(levelBudget("L1", budget) / 2) - 40);
  let base = l1Chunks;
  for (let depth = 2; depth <= INDEX_LEVEL_CAP; depth += 1) {
    const id = `L${depth}`;
    const chunks: LevelChunk[] = [];
    for (let i = 0; i < base.length; i += 2) {
      const a = base[i]!;
      const b = base[i + 1];
      const halfA = headHalf(a.text, halfCap);
      const text = b ? `${a.id}-${b.id} ${halfA} … ${headHalf(b.text, halfCap)}` : `${a.id} ${halfA}`;
      chunks.push({ id: `${id}.${chunks.length + 1}`, from: a.from, to: (b ?? a).to, chars: text.length, text });
    }
    // 折层后块数不降说明这层没有信息增益，停下别做死循环。
    if (chunks.length >= base.length) break;
    levels.push({ id, name: `${id}块目录`, total: base.length, chunks });
    base = chunks;
  }
  return { head, levels };
}

/** 从超限载荷生成分层索引树；连头部事实（faultCode/扫描计数等）都抽不出时返回 null，调用方回退原文切片。 */
export function indexTree(full: string): IndexTree | null {
  const { head, fullLabels } = payloadIndex(full);
  if (!head) return null;
  return buildLevels(head, fullLabels);
}

/** 渲染分层索引树：每层给层级标题（L1明细 / L2块目录）+ 块正文，装不下的块按 id 提示取回。 */
function renderTree(tree: IndexTree, budget: number): string {
  const lines: string[] = [tree.head];
  let used = tree.head.length;
  for (const level of tree.levels) {
    const unit = level.id === "L1" ? "条" : "块";
    const title = `${level.name}(共${level.total}${unit}，${level.chunks.length}块可寻址)`;
    if (used + title.length + 1 > budget) break;
    lines.push(title);
    used += title.length + 1;
    // 预算不够不整层丢弃：装不下的块逐个留一行 id+区间摘要，后面的层与块始终有痕迹。
    let folded = 0;
    for (const chunk of level.chunks) {
      const body = `${chunk.id}\n${chunk.text}`;
      if (used + body.length + 1 <= budget) {
        lines.push(body);
        used += body.length + 1;
        continue;
      }
      const stub = `…${chunk.id} 索引行${chunk.from}-${chunk.to}/${chunk.chars}字（按 id 取回）`;
      if (used + stub.length + 1 > budget) break;
      lines.push(stub);
      used += stub.length + 1;
      folded += 1;
    }
    if (folded) {
      const note = `…上列${folded}块只给了 id 与索引行区间，正文按 id 取回（evidence_search windows=[{callId,levelId}]）`;
      if (used + note.length + 1 <= budget) {
        lines.push(note);
        used += note.length + 1;
      }
    }
  }
  return lines.join("\n");
}

/** 分层目录：L1 是全量标签明细，L2 是 L1 全部块的上层封装，L3 又是 L2 的封装。
 * 每层都是完整的一份、可独立按 id 寻址，不是上一层装不下的剩余。 */
export function summarizePayload(full: string, tree?: IndexTree | null): string {
  const resolved = tree === undefined ? indexTree(full) : tree;
  if (!resolved) return "";
  const budget = Math.max(MIN_INDEX_LINE_CHARS, runtimeConfig.results.inlineChars - INDEX_OVERHEAD_RESERVE);
  return renderTree(resolved, budget);
}

/** 入窗门禁：超限载荷降级为摘要/指针，并带回告——要细节请更精准，取回再过同一门禁。 */
export function admitText(
  full: string,
  meta: { callId?: string; pageId?: string; path: string; name?: string; indexPath?: string; tree?: IndexTree | null },
): { mode: "inline"; text: string } | { mode: "preview"; payload: Record<string, unknown> } {
  const { inlineChars, previewChars, lineWidth, searchContextChars } = runtimeConfig.results;
  if (full.length <= inlineChars) return { mode: "inline", text: full };
  const totalLines = Math.ceil(full.length / lineWidth);
  const summary = summarizePayload(full, meta.tree);
  const structured = summary.length > 0;
  // 目录里实际存在的层：从 summary 里把 L1明细/L2块目录 这类层级行摘出来，模型一眼看到有哪些层可用。
  const levels = structured
    ? [
        ...new Set(
          summary
            .split("\n")
            .filter((line) => /^L\d+(明细|块目录)/.test(line))
            .map((line) => line.replace(/^L(\d+).*/, "L$1")),
        ),
      ]
    : [];
  // 层级块清单：把每层可寻址的 id/区间/字数直接放进指针，模型不读 index.json 就能按 id 取回。
  const tree = meta.tree === undefined ? indexTree(full) : meta.tree;
  const layers = tree
    ? tree.levels.map((level) => ({
        id: level.id,
        name: level.name,
        total: level.total,
        chunks: level.chunks.slice(0, LAYER_CHUNK_CAP).map((chunk) => ({
          id: chunk.id,
          from: chunk.from,
          to: chunk.to,
          chars: chunk.chars,
        })),
      }))
    : undefined;
  const locate = meta.pageId ? `pageId=${meta.pageId}` : `callId=${meta.callId ?? ""}`;
  // 可操作提示：降级文案不能只说「更精准」，得直接给出下一轮可用的取回锚点。
  // chunk.from/to 是 packRows 打包后的索引行坐标，与 .txt 的折行坐标系（startLine 用的那套）
  // 不同义，混用必然错位；唯一自洽的通道是按块 id 取回正文，所以主推 levelId。
  const finest = [...(layers ?? [])]
    .filter((layer) => layer.chunks.length > 0)
    .sort((a, b) => b.total - a.total)[0];
  const anchors = (finest?.chunks ?? []).slice(0, 3);
  const anchorHint = finest
    ? `建议按块取回（下面的区间是索引行，不能当 startLine 用）：${anchors
        .map((chunk) => `levelId=${chunk.id}（索引行${chunk.from}-${chunk.to}/${chunk.chars}字）`)
        .join(" 或 ")}（本层共 ${finest.chunks.length} 块可按 id 取回；全文 ${totalLines} 折行、每行约 ${lineWidth} 字，按行收窄请自行估 startLine）`
    : `建议按行收窄：startLine=1 起小段读（全文 ${totalLines} 行，约 ${lineWidth} 字/行）`;
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
      ...(layers ? { layers } : {}),
      // 结构化摘要可能接近门禁预算，不再重复一份头部；只有抽不出结构时才回退原文头部。
      ...(structured ? {} : { head: full.slice(0, previewChars) }),
      path: meta.path,
      ...(meta.indexPath ? { indexPath: meta.indexPath } : {}),
      message: structured
        ? `runtime: 内容超过 ${inlineChars} 字符，已降级为摘要指针（summary 为分层目录，含 ${levels.join("、") || "L1"}；每层行内自带「本层覆盖/总量」，直接在该层定位或再往上翻一层；全文 ${totalLines} 行${meta.indexPath ? `；完整不截断索引已落盘 ${meta.indexPath}` : ""}）。要细节请更精准：evidence_search(windows=[{${locate},keyword|startLine|levelId}])，可一次带多个窗口；${anchorHint}；${RETRIEVAL_INLINE_NOTE}`
        : `runtime: 内容超过 ${inlineChars} 字符，已降级为摘要指针（head 为原文前 ${previewChars} 字，全文 ${totalLines} 行）。要细节请更精准：evidence_search(windows=[{${locate},keyword|startLine|levelId}])，可一次带多个窗口；${anchorHint}；${RETRIEVAL_INLINE_NOTE}`,
      search: "evidence_search",
    },
  };
}

/** 门禁编排唯一入口：目录只算一次、落盘与指针渲染在同一处成型。
 * 落盘由调用方以回调注入（admission.ts 不碰文件系统），因此 loop.ts 与 execute.ts
 * 不再各自判断「要不要落盘」再手工传 indexPath——那正是漏传会让文案撒谎的地方。 */
export function admitReturn(
  full: string,
  meta: { callId?: string; pageId?: string; path: string; name?: string },
  options: { tree?: IndexTree | null; persistTree?: (tree: IndexTree) => string } = {},
): { mode: "inline"; text: string } | { mode: "preview"; payload: Record<string, unknown> } {
  if (full.length <= runtimeConfig.results.inlineChars) {
    return admitText(full, { ...meta, tree: options.tree ?? null });
  }
  const tree = options.tree === undefined ? indexTree(full) : options.tree;
  const indexPath = tree && options.persistTree ? options.persistTree(tree) : undefined;
  return admitText(full, { ...meta, tree, ...(indexPath ? { indexPath } : {}) });
}

/** 取回型语义的唯一说明来源：取回型工具（evidence_search / asset_read）经 admitExecution 的
 *  admitted 通道按检索预算直接内联，取回的正文不会再被二次降级；图片裁切/重截不走该通道，
 *  仍按入窗门槛判定。降级 message 里对模型描述这条事实时只引用这里，不另写一份。 */
const RETRIEVAL_INLINE_NOTE = "取回结果按检索预算内联，不会二次降级。";

/** 门禁编排：工具自报已按预算裁剪过（admitted）时直接内联，否则走 admitReturn。
 *  取回型工具（evidence_search / asset_read）走这条免二次外置通道；
 *  产出型工具不设该标记，行为与此前完全一致。 */
export function admitExecution(
  full: string,
  admitted: boolean | undefined,
  meta: { callId?: string; pageId?: string; path: string; name?: string },
  options: { tree?: IndexTree | null; persistTree?: (tree: IndexTree) => string } = {},
): { mode: "inline"; text: string } | { mode: "preview"; payload: Record<string, unknown> } {
  if (admitted) return { mode: "inline", text: full };
  return admitReturn(full, meta, options);
}

/** 图片侧的对应事实：裁切/重截不走 admitted 通道，其返回仍按入窗门槛判定。 */
const IMAGE_REFLOW_NOTE = "裁切/重截后的图片仍按入窗门槛判定。";

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
    fetchHint: `信息已降级。要细节请更精准：image_crop 裁更小矩形，或 capture_page(mode=element|rect)；${IMAGE_REFLOW_NOTE}`,
  };
}

export function deferredImageNote(deferred: Pick<ImageReference, "id" | "path" | "width" | "height" | "bytes">[]): string {
  if (!deferred.length) return "";
  const rows = deferred.map((image) => `${image.id} ${image.width}x${image.height} ${image.bytes}B`).join(", ");
  return `runtime: 图片超过入窗门槛未附带像素（${rows}）。要画面请更精准：image_crop 或 capture_page(mode=element|rect) 只取目标区域；${IMAGE_REFLOW_NOTE}`;
}
