import postcss, { CssSyntaxError, type ChildNode } from "postcss";

type CssStructure = {
  boundaries: { offset: number; depth: number }[];
  labels: { start: number; end: number; title: string; depth: number }[];
};

/** Use parser offsets so comments, escapes and values stay byte-for-byte in the source snapshot. */
export function cssStructure(text: string): CssStructure {
  const result: CssStructure = { boundaries: [], labels: [] };
  let root;
  try {
    root = postcss.parse(text);
  } catch (error) {
    // A selected line range can be an incomplete stylesheet; use ordinary text boundaries then.
    if (error instanceof CssSyntaxError) return result;
    throw error;
  }

  function visit(nodes: ChildNode[], depth: number): void {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      const start = node.source!.start!.offset! - (node.raws.before?.length ?? 0);
      const end = node.source!.end!.offset!;
      // Split between siblings. Parent headers and closing braces remain with their children,
      // rather than forming tiny extra levels around otherwise identical ranges.
      if (i > 0) result.boundaries.push({ offset: start, depth });
      const title = node.type === "rule" ? node.selector
        : node.type === "atrule" ? `@${node.name}${node.params ? ` ${node.params}` : ""}`
          : node.type === "decl" ? node.prop : undefined;
      if (title) result.labels.push({ start, end, depth, title: title.slice(0, 100) });
      if ((node.type === "rule" || node.type === "atrule") && node.nodes) visit(node.nodes, depth + 1);
    }
  }
  visit(root.nodes, 0);
  return result;
}
