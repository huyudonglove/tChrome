import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { runtimeConfig } from './runtime.ts';

const SERVICE_DIR = new URL('..', import.meta.url).pathname;

// Bare literals must not creep back into source: every gate value lives in
// runtime.json. The values are read from the live config so this scanner keeps
// working after the base window (and the derived gates) are rescaled.
// Only distinctive magnitudes are scanned. Small gates (previewChars/summaryChars
// at 400) collide with unrelated numbers such as HTTP status codes.
const GATE_VALUES = [
  runtimeConfig.context.compressAtChars,
  runtimeConfig.context.hardLimitChars,
  runtimeConfig.results.inlineChars,
  runtimeConfig.results.imageInlineBytes,
];

const SCAN_EXT = new Set(['.ts', '.tsx', '.json']);

// Files that legitimately spell one of these numbers for their own reasons.
const ALLOWLIST: { file: string; reason: string }[] = [
  { file: 'config/runtime.ts', reason: 'implements the derivation' },
  { file: 'config/runtime.json', reason: 'the source of truth itself' },
  { file: 'config/runtime.test.ts', reason: 'pins the derivation with literal expectations' },
  { file: 'tools/definitions/', reason: 'raw definitions carry {{inlineChars}} placeholders' },
  { file: 'admission.test.ts', reason: 'image width fixture, not a gate' },
  { file: 'tools/local-process.test.ts', reason: 'synthesises that much process output' },
  { file: 'tools/tavily-search.ts', reason: 'Tavily query length limit, not our gate' },
  { file: 'tools/tavily-schema.test.ts', reason: 'Tavily query length limit, not our gate' },
  { file: 'widgets/store.ts', reason: 'widget HTML byte limit, unrelated to context gates' },
];

const isAllowed = (rel: string) => ALLOWLIST.some((entry) => rel.startsWith(entry.file));

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (SCAN_EXT.has(full.slice(full.lastIndexOf('.')))) yield full;
  }
}

test('no gate value is hardcoded outside runtime config', () => {
  const hits: string[] = [];
  for (const file of walk(SERVICE_DIR)) {
    const rel = file.slice(SERVICE_DIR.length);
    if (isAllowed(rel)) continue;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const value of GATE_VALUES) {
          if (new RegExp(`\\b${value}\\b`).test(line)) hits.push(`${rel}:${i + 1} ${line.trim()}`);
        }
      });
  }
  expect(hits).toEqual([]);
});
