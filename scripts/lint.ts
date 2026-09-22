#!/usr/bin/env bun
import { join } from "node:path";
import { lintPath } from "../service/runtime/linter.ts";

const target = process.argv[2] || join(import.meta.dir, "..");
console.log(`Running Fast Linter on: ${target}`);

const start = performance.now();
const summary = lintPath(target);
const duration = (performance.now() - start).toFixed(2);

console.log(summary.formattedReport);
console.log(`\nDiagnostics finished in ${duration}ms`);

if (summary.totalErrors > 0) {
  process.exit(1);
}
