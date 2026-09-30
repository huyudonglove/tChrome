import { errorInfo } from "../../shared/errors.ts";
import { lstat, readFile } from "node:fs/promises";
import { extname } from "node:path";
import ts from "typescript";
import { integer, pathArg } from "./local-files.ts";

type OutlineNode = {
  tag: string;
  classes: string[];
  dynamic: boolean;
  children: OutlineNode[];
};

const ALLOWED_EXT = new Set([".tsx", ".jsx"]);

function tagName(node: ts.JsxTagNameExpression): string {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return `${tagName(node.expression as ts.JsxTagNameExpression)}.${node.name.text}`;
  return node.getText();
}

function readClassName(attr: ts.JsxAttribute): { tokens: string[]; dynamic: boolean } {
  const init = attr.initializer;
  if (!init) return { tokens: [], dynamic: false };
  if (ts.isStringLiteral(init)) {
    return { tokens: init.text.split(/\s+/).filter(Boolean), dynamic: false };
  }
  if (!ts.isJsxExpression(init) || !init.expression) return { tokens: [], dynamic: false };
  const tokens = new Set<string>();
  let dynamic = false;
  const scan = (expr: ts.Expression) => {
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      for (const token of expr.text.split(/\s+/)) if (token) tokens.add(token);
      return;
    }
    if (ts.isTemplateExpression(expr)) {
      if (expr.head.text.trim()) tokens.add(expr.head.text.trim());
      for (const span of expr.templateSpans) {
        if (ts.isStringLiteral(span.expression) || ts.isNoSubstitutionTemplateLiteral(span.expression)) {
          for (const token of span.expression.text.split(/\s+/)) if (token) tokens.add(token);
        } else {
          dynamic = true;
        }
        if (span.literal.text.trim()) tokens.add(span.literal.text.trim());
      }
      return;
    }
    if (ts.isConditionalExpression(expr)) {
      scan(expr.whenTrue);
      scan(expr.whenFalse);
      if (!ts.isStringLiteral(expr.condition) && !ts.isNoSubstitutionTemplateLiteral(expr.condition)) dynamic = true;
      return;
    }
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      scan(expr.left);
      scan(expr.right);
      return;
    }
    dynamic = true;
  };
  scan(init.expression);
  return { tokens: [...tokens], dynamic };
}

function buildNode(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement, dynamicClass: boolean, classTokens: string[]): OutlineNode {
  return {
    tag: tagName(opening.tagName),
    classes: classTokens,
    dynamic: dynamicClass,
    children: [],
  };
}

function classNameOf(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement): { tokens: string[]; dynamic: boolean } {
  for (const attr of opening.attributes.properties) {
    if (ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name) && attr.name.text === "className") return readClassName(attr);
  }
  return { tokens: [], dynamic: false };
}

/** Depth-first walk of JSX children; fragments and expressions recurse without emitting nodes. */
function walkChildren(parent: OutlineNode, children: ts.NodeArray<ts.JsxChild>, depth: number, maxDepth: number, stats: { elements: number; components: number }): void {
  if (maxDepth > 0 && depth >= maxDepth) return;
  for (const child of children) {
    if (ts.isJsxText(child)) continue;
    if (ts.isJsxElement(child)) {
      const opening = child.openingElement;
      const { tokens, dynamic } = classNameOf(opening);
      const node = buildNode(opening, dynamic, tokens);
      stats.elements++;
      if (/^[A-Z]/.test(node.tag)) stats.components++;
      parent.children.push(node);
      walkChildren(node, child.children, depth + 1, maxDepth, stats);
    } else if (ts.isJsxSelfClosingElement(child)) {
      const { tokens, dynamic } = classNameOf(child);
      const node = buildNode(child, dynamic, tokens);
      stats.elements++;
      if (/^[A-Z]/.test(node.tag)) stats.components++;
      parent.children.push(node);
    } else if (ts.isJsxFragment(child)) {
      walkChildren(parent, child.children, depth, maxDepth, stats);
    } else if (ts.isJsxExpression(child) && child.expression) {
      walkExpression(parent, child.expression, depth, maxDepth, stats);
    }
  }
}

function walkExpression(parent: OutlineNode, expr: ts.Expression, depth: number, maxDepth: number, stats: { elements: number; components: number }): void {
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const { tokens, dynamic } = classNameOf(opening);
      const outline = buildNode(opening, dynamic, tokens);
      stats.elements++;
      if (/^[A-Z]/.test(outline.tag)) stats.components++;
      parent.children.push(outline);
      if (ts.isJsxElement(node)) walkChildren(outline, node.children, depth + 1, maxDepth, stats);
      return;
    }
    if (ts.isJsxFragment(node)) {
      for (const child of node.children) visit(child);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expr);
}

function renderSkeleton(nodes: OutlineNode[], depth: number, lines: string[], classTally: Map<string, number>): void {
  for (const node of nodes) {
    for (const cls of node.classes) classTally.set(cls, (classTally.get(cls) ?? 0) + 1);
    const cls = node.classes.length ? `.${node.classes.join(".")}` : "";
    const dyn = node.dynamic ? "…" : "";
    lines.push(`${"  ".repeat(depth)}${node.tag}${cls}${dyn}`);
    renderSkeleton(node.children, depth + 1, lines, classTally);
  }
}

export async function runTsxOutline(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const path = pathArg(input);
    const ext = extname(path).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) throw new Error("path must be a .tsx or .jsx file");
    const maxDepth = integer(input, "maxDepth", 0, 0, 50);
    const maxFileBytes = integer(input, "maxFileBytes", 1048576, 1, 1048576);
    const stat = await lstat(path);
    if (!stat.isFile()) throw new Error("path must be a regular file");
    if (stat.size > maxFileBytes) throw new Error(`file exceeds maxFileBytes (${stat.size} > ${maxFileBytes})`);
    const text = await readFile(path, "utf8");
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ext === ".jsx" ? ts.ScriptKind.JSX : ts.ScriptKind.TSX);

    const roots: OutlineNode[] = [];
    const stats = { elements: 0, components: 0 };
    const topVisit = (node: ts.Node) => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        const { tokens, dynamic } = classNameOf(opening);
        const outline = buildNode(opening, dynamic, tokens);
        stats.elements++;
        if (/^[A-Z]/.test(outline.tag)) stats.components++;
        roots.push(outline);
        if (ts.isJsxElement(node)) walkChildren(outline, node.children, 1, maxDepth, stats);
        return; // do not re-enter this subtree
      }
      ts.forEachChild(node, topVisit);
    };
    ts.forEachChild(source, topVisit);

    const lines: string[] = [];
    const classTally = new Map<string, number>();
    renderSkeleton(roots, 0, lines, classTally);
    const classes = [...classTally.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([cls, count]) => ({ cls, count }));
    return {
      ok: true,
      path,
      skeleton: lines.join("\n"),
      classes,
      stats: { ...stats, lines: lines.length },
    };
  } catch (error) {
    const { faultCode, detail } = errorInfo(error, "tool_execution_failed");
    return { ok: false, path: typeof input.path === "string" ? input.path : undefined, faultCode, error: detail };
  }
}
