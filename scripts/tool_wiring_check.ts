#!/usr/bin/env bun
/**
 * Tool wiring check: report tools that are declared but never dispatched, and
 * schema files nobody declared.
 *
 * Dispatch order in service/tools/execute.ts is: inline `name === "..."`
 * branches, then JOB / STREAM / IMAGE / asset / LOCAL / SERVICE / COMPOUND,
 * then host.execute for browser names, and finally the unknown_tool fallback.
 * This script mirrors that order to build the "actually wired" set and diffs it
 * against service/tools/definitions/index.json plus groups.json.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fillNumbers } from "../service/tools/registry.ts";
import { LOCAL_TOOL_NAMES } from "../service/tools/local-tools.ts";
import { SERVICE_TOOL_NAMES } from "../service/tools/service-tools.ts";
import { COMPOUND_TOOL_NAMES } from "../service/tools/compound-tools.ts";
import { JOB_TOOL_NAMES } from "../service/tools/job-registry.ts";
import { STREAM_TOOL_NAMES } from "../service/tools/stream-tools.ts";
import { IMAGE_TOOL_NAMES } from "../service/tools/image-crop.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const defsDir = join(root, "service", "tools", "definitions");
const readJson = (path: string): any => JSON.parse(fillNumbers(readFileSync(path, "utf8")));

const index = readJson(join(defsDir, "index.json")) as { browser: string[]; service: string[] };
const groups = readJson(join(defsDir, "groups.json")) as { baseToolsIds: string[]; coreToolIds: string[] };

/** Inline branches in execute.ts: `if (name === "...")`. */
const inlineDispatched = (): string[] => {
  const src = readFileSync(join(root, "service", "tools", "execute.ts"), "utf8");
  return [...src.matchAll(/name === "([^"]+)"/g)].map((match) => match[1]!);
};

/** Browser tools reach the extension through host.execute; count both the name list and the dispatch branches. */
const browserDispatched = (): string[] => {
  const src = readFileSync(join(root, "extension", "tools", "browser-tools.js"), "utf8");
  const start = src.indexOf("BROWSER_TOOL_NAMES = [");
  const end = start < 0 ? -1 : src.indexOf("];", start);
  const listed = start < 0 || end < 0 ? [] : [...src.slice(start, end).matchAll(/'([^']+)'/g)].map((match) => match[1]!);
  const branched = [...src.matchAll(/name === '([^']+)'/g)].map((match) => match[1]!);
  return [...listed, ...branched];
};

/** Schema files shipped under definitions/ and the name each one declares. */
const definitionNames = (): Set<string> => {
  const names = new Set<string>();
  for (const file of readdirSync(defsDir)) {
    if (!file.endsWith(".json") || file === "index.json" || file === "groups.json") continue;
    const name = (readJson(join(defsDir, file)) as { function?: { name?: string } }).function?.name;
    if (name) names.add(name);
  }
  return names;
};

/**
 * Object schemas that declare `properties` must also declare `additionalProperties`;
 * without it Ajv silently accepts unknown fields (typos, or fields borrowed from another tool).
 * Combinator branches (anyOf/oneOf/allOf, if/then/else) are skipped on purpose: an
 * `additionalProperties:false` written inside a branch only sees that branch's own properties, so
 * requiring it there would reject sibling fields the outer schema allows.
 */
const openObjectSchemas = (): string[] => {
  const rows: string[] = [];
  const walk = (node: any, path: string): void => {
    if (!node || typeof node !== "object") return;
    if (node.properties && typeof node.properties === "object" && !("additionalProperties" in node)) {
      rows.push(path);
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) walk(child, `${path}.${key}`);
    const items = node.items;
    if (!items) return;
    for (const [index, child] of (Array.isArray(items) ? items : [items]).entries()) {
      walk(child, Array.isArray(items) ? `${path}.items[${index}]` : `${path}.items`);
    }
  };
  for (const file of readdirSync(defsDir)) {
    if (!file.endsWith(".json") || file === "index.json" || file === "groups.json") continue;
    const parameters = (readJson(join(defsDir, file)) as { function?: { parameters?: unknown } }).function?.parameters;
    if (parameters) walk(parameters, file.replace(/\.json$/, ""));
  }
  return rows.sort();
};

const wired = new Set<string>([
  ...inlineDispatched(),
  ...browserDispatched(),
  ...LOCAL_TOOL_NAMES,
  ...SERVICE_TOOL_NAMES,
  ...COMPOUND_TOOL_NAMES,
  ...JOB_TOOL_NAMES,
  ...STREAM_TOOL_NAMES,
  ...IMAGE_TOOL_NAMES,
]);

const declared = new Set<string>([
  ...index.browser,
  ...index.service,
  ...groups.baseToolsIds,
  ...groups.coreToolIds,
]);
const schemas = definitionNames();
const openObjects = openObjectSchemas();

const unwired = [...declared].filter((name) => !wired.has(name)).sort();
const missingSchema = [...declared].filter((name) => !schemas.has(name)).sort();
const orphanSchema = [...schemas].filter((name) => !declared.has(name)).sort();

console.log(`declared: ${index.browser.length} browser + ${index.service.length} service + ${groups.baseToolsIds.length} base + ${groups.coreToolIds.length} core`);
console.log(`wired: ${wired.size}`);
console.log(`schemas: ${schemas.size}`);

const report = (title: string, rows: string[]) => {
  if (!rows.length) return;
  console.log(`\n${title} (${rows.length})`);
  for (const row of rows) console.log(`  - ${row}`);
};

report("declared but never dispatched", unwired);
report("declared but no schema file", missingSchema);
report("schema file not declared anywhere", orphanSchema);
report("object schema without additionalProperties", openObjects);

const blocking = unwired.length + missingSchema.length + orphanSchema.length + openObjects.length;
if (blocking) {
  console.log(`\nFAIL: ${blocking} wiring problem(s) found.`);
  process.exit(1);
}
console.log("\nOK: every declared tool is wired.");
