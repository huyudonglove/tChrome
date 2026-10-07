import ts from "typescript";
import { cssStructure } from "./css.ts";
import { runtimeConfig } from "../config/runtime.ts";

export type BlockSource = { id: string; text: string; path?: string; jsonPath?: string; startLine?: number };
export type BlockNode = {
  id: string;
  parentId?: string;
  sourceId?: string;
  start: number;
  end: number;
  title: string;
  children: string[];
};
export type BlockIndex = { rootId: string; sources: BlockSource[]; nodes: BlockNode[] };
export type BlockLocation = { path?: string; jsonPath?: string; startLine?: number; endLine?: number };
export type BlockSummary = { blockId: string; parentBlockId?: string; title: string; chars: number; kind: "directory" | "content"; source: BlockLocation };
export type BlockRead =
  | { kind: "directory"; blockId: string; parentBlockId?: string; title: string; children: BlockSummary[] }
  | { kind: "content"; blockId: string; parentBlockId?: string; title: string; content: string; source: BlockLocation };
export type BlockSearchHit = BlockSummary & { snippet: string };

type Boundary = { offset: number; depth: number };
type Structure = { boundaries: Boundary[]; labels: { start: number; end: number; title: string; depth: number }[] };

const lineStartsCache = new WeakMap<BlockSource, number[]>();

function location(source: BlockSource | undefined, node: BlockNode): BlockLocation {
  if (!source) return {};
  const firstLine = source.startLine ?? 1;
  return {
    ...(source.path ? { path: source.path } : {}),
    ...(source.jsonPath ? { jsonPath: source.jsonPath } : {}),
    startLine: firstLine + countLines(source, node.start),
    endLine: firstLine + countLines(source, Math.max(node.start, node.end - 1)),
  };
}

function countLines(source: BlockSource, end: number): number {
  let starts = lineStartsCache.get(source);
  if (!starts) {
    starts = [];
    for (let i = 0; i < source.text.length; i++) if (source.text.charCodeAt(i) === 10) starts.push(i + 1);
    lineStartsCache.set(source, starts);
  }
  let low = 0; let high = starts.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (starts[mid]! <= end) low = mid + 1; else high = mid;
  }
  return low;
}

function summarize(index: BlockIndex, node: BlockNode): BlockSummary {
  const source = index.sources.find((item) => item.id === node.sourceId);
  return { blockId: node.id, ...(node.parentId ? { parentBlockId: node.parentId } : {}), title: node.title, chars: node.end - node.start,
    kind: node.children.length ? "directory" : "content", source: location(source, node) };
}

/** A directory always identifies itself; a content block always contains its entire original range. */
export function readBlock(index: BlockIndex, blockId: string): BlockRead | undefined {
  const node = index.nodes.find((item) => item.id === blockId);
  if (!node) return undefined;
  if (node.children.length) {
    const nodes = new Map(index.nodes.map((item) => [item.id, item]));
    return { kind: "directory", blockId, ...(node.parentId ? { parentBlockId: node.parentId } : {}), title: node.title,
      children: node.children.map((id) => summarize(index, nodes.get(id)!)) };
  }
  const source = index.sources.find((item) => item.id === node.sourceId);
  if (!source) throw new Error(`Content block ${blockId} has no source`);
  return { kind: "content", blockId, ...(node.parentId ? { parentBlockId: node.parentId } : {}), title: node.title,
    content: source.text.slice(node.start, node.end), source: location(source, node) };
}

/** Search only original content, returning IDs that readBlock resolves to full content. */
export function searchBlocks(index: BlockIndex, keyword: string): BlockSearchHit[] {
  if (!keyword) return [];
  const needle = keyword.toLocaleLowerCase();
  const hits = new Map<string, BlockSearchHit>();
  for (const source of index.sources) {
    const text = source.text.toLocaleLowerCase();
    const leaves = index.nodes.filter((node) => node.sourceId === source.id && !node.children.length);
    let at = text.indexOf(needle);
    while (at >= 0) {
      for (const node of leaves) {
        if (node.start >= at + keyword.length || node.end <= at || hits.has(node.id)) continue;
        hits.set(node.id, { ...summarize(index, node),
          snippet: source.text.slice(Math.max(0, at - 80), at + keyword.length + 160) });
      }
      at = text.indexOf(needle, at + 1);
    }
  }
  return [...hits.values()];
}

function structureOf(source: BlockSource): Structure {
  const result: Structure = { boundaries: [], labels: [] };
  const path = source.path ?? "";
  if (/\.css$/i.test(path)) return cssStructure(source.text);
  const isCode = /\.[cm]?[jt]sx?$/i.test(path);
  let isJson = /\.json$/i.test(path);
  if (!isCode && !isJson) {
    try { const value: unknown = JSON.parse(source.text); isJson = value !== null && typeof value === "object"; } catch { /* Plain text uses textual boundaries. */ }
  }
  if (!isCode && !isJson) return result;
  const file = isJson ? ts.parseJsonText(path || "result.json", source.text)
    : ts.createSourceFile(path, source.text, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node, depth: number): void {
    // SyntaxList/token boundaries would split expressions needlessly. AST children expose semantic ranges.
    ts.forEachChild(node, (child) => {
      const start = child.getFullStart();
      const end = child.end;
      result.boundaries.push({ offset: start, depth }, { offset: end, depth });
      const named = child as ts.NamedDeclaration;
      if (named.name && (ts.isFunctionDeclaration(child) || ts.isClassDeclaration(child)
        || ts.isMethodDeclaration(child) || ts.isVariableDeclaration(child) || ts.isPropertyAssignment(child)
        || ts.isInterfaceDeclaration(child) || ts.isTypeAliasDeclaration(child) || ts.isEnumDeclaration(child))) {
        result.labels.push({ start, end, depth, title: named.name.getText(file).slice(0, 100) });
      }
      visit(child, depth + 1);
    });
  }
  visit(file, 0);
  return result;
}

function textCuts(text: string, start: number, end: number): number[] {
  const part = text.slice(start, end);
  for (const pattern of [/\r?\n[\t ]*\r?\n/g, /\r?\n/g, /[.!?。！？][\t ]+/g]) {
    const cuts = [...part.matchAll(pattern)].map((match) => start + match.index! + match[0].length)
      .filter((offset) => offset > start && offset < end);
    if (cuts.length) return cuts;
  }
  return [];
}

/** Build one immutable source snapshot and one uniform tree, independent of the input format. */
export function buildBlockIndex(full: string, options: { maxChars?: number; path?: string } = {}): BlockIndex {
  const maxChars = options.maxChars ?? (runtimeConfig.results.inlineChars - runtimeConfig.results.pointerShellReserve);
  if (!Number.isInteger(maxChars) || maxChars <= 0) throw new Error("maxChars must be a positive integer");
  const index: BlockIndex = { rootId: "", sources: [], nodes: [] };
  let sequence = 0;
  // Include the final parent ID width before directory grouping assigns it. The bound
  // covers raw plus decoded sources, one-character leaves and their grouping nodes.
  const parentBudgetId = `blk_${String(full.length * 8 + 8).padStart(2, "0")}`;
  const addNode = (fields: Omit<BlockNode, "id">): BlockNode => {
    const node = { id: `blk_${String(++sequence).padStart(2, "0")}`, ...fields };
    index.nodes.push(node);
    return node;
  };
  const attach = (node: BlockNode, children: BlockNode[]): void => {
    node.children = children.map((child) => child.id);
    for (const child of children) child.parentId = node.id;
  };
  function directoryFits(node: BlockNode, children: BlockNode[]): boolean {
    return JSON.stringify({ kind: "directory", blockId: node.id, parentBlockId: parentBudgetId, title: node.title,
      children: children.map((child) => ({ ...summarize(index, child), parentBlockId: node.id })) }).length <= maxChars;
  }
  function groupDirectory(node: BlockNode, children: BlockNode[]): void {
    if (directoryFits(node, children)) { attach(node, children); return; }
    const groups: BlockNode[][] = [];
    let group: BlockNode[] = [];
    for (const child of children) {
      if (group.length && !directoryFits(node, [...group, child])) { groups.push(group); group = []; }
      group.push(child);
    }
    if (group.length) groups.push(group);
    if (groups.length === children.length) throw new Error("Block directory metadata exceeds maxChars");
    const grouped = groups.map((items) => {
      const first = items[0]!; const last = items[items.length - 1]!;
      const parent = addNode({ title: "Blocks", sourceId: first.sourceId === last.sourceId ? first.sourceId : undefined,
        start: first.start, end: last.end, children: [] });
      groupDirectory(parent, items);
      return parent;
    });
    groupDirectory(node, grouped);
  }
  function addSource(text: string, metadata: Omit<BlockSource, "id" | "text">): BlockNode {
    const source: BlockSource = { id: `src_${String(index.sources.length + 1).padStart(2, "0")}`, text, ...metadata };
    index.sources.push(source);
    const structure = structureOf(source);
    function titleFor(start: number, end: number): string {
      const label = structure.labels.filter((item) => item.start <= start && item.end >= end)
        .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
      // CSS containers often span many selector groups. Name those groups by their
      // contained rules instead of repeating the enclosing @media label at every level.
      if (label && (!/\.css$/i.test(source.path ?? "") || (label.start === start && label.end === end))) return label.title;
      const contained = structure.labels.filter((item) => item.start >= start && item.end <= end);
      if (contained.length) {
        const depth = contained.reduce((depth, item) => Math.min(depth, item.depth), Infinity);
        const peers = contained.filter((item) => item.depth === depth);
        const first = peers[0]!.title; const last = peers[peers.length - 1]!.title;
        return (first === last ? first : `${first} … ${last}`).slice(0, 100);
      }
      if (label) return label.title;
      return (source.path?.split(/[\\/]/).pop() || source.jsonPath || "Result").slice(0, 100);
    }
    function fits(start: number, end: number): boolean {
      // Include JSON escaping and the actual result envelope, not just source character count.
      const candidate: BlockNode = { id: `blk_${String(sequence + 1).padStart(2, "0")}`, sourceId: source.id,
        start, end, title: titleFor(start, end), children: [] };
      return JSON.stringify({ kind: "content", blockId: candidate.id, parentBlockId: parentBudgetId, title: candidate.title,
        content: text.slice(start, end), source: location(source, candidate) }).length <= maxChars;
    }
    function split(start: number, end: number): BlockNode {
      const node = addNode({ sourceId: source.id, start, end, title: titleFor(start, end), children: [] });
      if (fits(start, end)) return node;
      const inside = structure.boundaries.filter((item) => item.offset > start && item.offset < end);
      const shallowest = inside.reduce((depth, item) => Math.min(depth, item.depth), Infinity);
      let cuts = [...new Set(inside.filter((item) => item.depth === shallowest).map((item) => item.offset))].sort((a, b) => a - b);
      if (!cuts.length) cuts = textCuts(text, start, end);
      if (!cuts.length) {
        // No semantic or text boundary remains: split by Unicode code point within the output budget.
        let cursor = start;
        while (cursor < end) {
          let low = cursor; let high = end;
          while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (fits(cursor, mid)) low = mid; else high = mid - 1;
          }
          if (low < end && low > cursor && /[\uD800-\uDBFF]/.test(text[low - 1]!) && /[\uDC00-\uDFFF]/.test(text[low]!)) low--;
          if (low <= cursor) throw new Error("Block metadata or one character exceeds maxChars");
          if (low < end) cuts.push(low);
          cursor = low;
        }
      }
      const points = [...cuts, end];
      const ranges: [number, number][] = [];
      let left = start; let right = start;
      for (const point of points) {
        if (right > left && !fits(left, point)) { ranges.push([left, right]); left = right; }
        right = point;
      }
      if (right > left) ranges.push([left, right]);
      if (ranges.length === 1 && ranges[0]![0] === start && ranges[0]![1] === end) {
        // A single oversized structural unit must descend to its internal boundaries.
        const cut = cuts[0];
        if (cut === undefined) throw new Error("Unable to split source within maxChars");
        ranges.splice(0, 1, [start, cut], [cut, end]);
      }
      groupDirectory(node, ranges.map(([left, right]) => split(left, right)));
      return node;
    }
    return split(0, text.length);
  }
  const sourceRoots = [addSource(full, options.path ? { path: options.path } : {})];
  // local_fs_read JSON carries escaped source. Preserve its immutable raw snapshot and expose
  // decoded file content as independently addressable sources with precise file line locations.
  try {
    const parsed: unknown = JSON.parse(full);
    if (parsed && typeof parsed === "object" && "results" in parsed && Array.isArray(parsed.results)) {
      parsed.results.forEach((item: unknown, i: number) => {
        if (!item || typeof item !== "object" || !("content" in item) || typeof item.content !== "string"
          || !("path" in item) || typeof item.path !== "string") return;
        const startLine = "startLine" in item && typeof item.startLine === "number" ? item.startLine : 1;
        sourceRoots.push(addSource(item.content, { path: item.path, jsonPath: `$.results[${i}].content`, startLine }));
      });
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  if (sourceRoots.length === 1) index.rootId = sourceRoots[0]!.id;
  else {
    const root = addNode({ title: "Result sources", start: 0, end: full.length, children: [] });
    groupDirectory(root, sourceRoots);
    index.rootId = root.id;
  }
  return index;
}
