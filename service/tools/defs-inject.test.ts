import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadToolRegistry } from './registry.ts';
import { runtimeConfig } from '../config/runtime.ts';
import { promptNumberSlots } from '../context/prompt-numbers.ts';

const root = join(import.meta.dir, '../..');
const registry = loadToolRegistry(root);

test('no definition leaks an unresolved {{slot}} placeholder', () => {
  for (const [name, tool] of Object.entries(registry.tools)) {
    expect(`${name}:${JSON.stringify(tool)}`).not.toMatch(/\{\{\w+\}\}/);
  }
});

test('description gates carry the configured inlineChars', () => {
  const slots = promptNumberSlots();
  const query = registry.tools['context_query'];
  expect(query?.function?.description).toContain(slots.inlineChars!);
  expect(query?.function?.description).not.toMatch(/\{\{\w+\}\}/);
});

test('intent maxLength equals the configured intentMaxChars', () => {
  const params = registry.tools['context_query']?.function?.parameters as any;
  expect(params.properties.intent.maxLength).toBe(runtimeConfig.results.intentMaxChars);
});

test('raw definition files carry placeholders, not hardcoded gate numbers', () => {
  const file = join(root, 'service', 'tools', 'definitions', 'context_query.json');
  const text = readFileSync(file, 'utf8');
  expect(text).toContain('{{inlineChars}}');
  expect(text).toContain('{{intentMaxChars}}');
  expect(text).not.toContain(String(runtimeConfig.results.inlineChars));
  expect(text).not.toContain(String(runtimeConfig.results.intentMaxChars));
});
