#!/usr/bin/env bun
import { join } from "node:path";
import { buildRepoMap } from "../service/runtime/repo-map.ts";

const targetDir = process.argv[2] || join(import.meta.dir, "..");
const maxLines = process.argv[3] ? parseInt(process.argv[3], 10) : 100;

const result = buildRepoMap(targetDir, { maxLines });

console.log("=== Repository Summary ===");
console.log(`Total Source Files Analyzed: ${result.totalFiles}`);
console.log(`Total Top-level Symbols Extracted: ${result.totalSymbols}`);
console.log("\n=== Rendered Repo Map Preview ===");
console.log(result.renderedMap);
