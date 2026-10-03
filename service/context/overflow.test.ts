import {test, expect} from 'bun:test';
import {mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {externalizeContext, CONTEXT_INLINE_CHARS} from './overflow.ts';
import { runtimeConfig } from '../config/runtime.ts';

const INLINE = runtimeConfig.context.externalizeAtChars;

const measure = (slots: Record<string, string>) => Object.values(slots).reduce((sum, text) => sum + text.length, 0);
function temporary(run: (dataDir: string) => void) {
  const dataDir = mkdtempSync(join(tmpdir(), 'context-overflow-'));
  try { run(dataDir); } finally { rmSync(dataDir, {recursive: true, force: true}); }
}
test(`${INLINE} characters remain inline, larger content is stored whole with absolute path`, () => temporary(dataDir => {
  expect(CONTEXT_INLINE_CHARS).toBe(INLINE);
  const exact = {'#notes': 'a'.repeat(INLINE)};
  expect(externalizeContext({dataDir, slots: exact, measure})).toEqual(exact);
  expect(readdirSync(dataDir)).toEqual([]);
  const slots = {'#notes': JSON.stringify({note: '中'.repeat(CONTEXT_INLINE_CHARS)})};
  const result = externalizeContext({dataDir, slots, measure});
  const {contextFile} = JSON.parse(result['#notes']!);
  expect(isAbsolute(contextFile.path)).toBe(true);
  expect(contextFile.format).toBe('json');
  expect(contextFile.chars).toBe(slots['#notes'].length);
  expect(readFileSync(contextFile.path, 'utf8')).toBe(slots['#notes']);
  expect(slots['#notes']).toContain('中');
  expect(measure(result)).toBeLessThanOrEqual(CONTEXT_INLINE_CHARS);
}));
test('cumulative movable slots respect the budget and retain tools', () => temporary(dataDir => {
  const slots = {'#tools': 't'.repeat(10000), '#projectMemory': 'm'.repeat(220000), '#conversation': 'c'.repeat(120000)};
  const result = externalizeContext({dataDir, slots, measure});
  expect(result['#tools']).toBe(slots['#tools']);
  expect(result['#conversation']).toBe(slots['#conversation']);
  expect(JSON.parse(result['#projectMemory']!).contextFile).toBeDefined();
  expect(measure(result)).toBeLessThanOrEqual(CONTEXT_INLINE_CHARS);
}));
test('skill stays verbatim while repeated projections reuse externalized data', () => temporary(dataDir => {
  const slots = {'#skill': 'instructions '.repeat(18000), '#notes': JSON.stringify({draft: 'n'.repeat(90000)})};
  const first = externalizeContext({dataDir, slots, measure});
  expect(first['#skill']).toBe(slots['#skill']);
  expect(externalizeContext({dataDir, slots, measure})).toEqual(first);
  expect(externalizeContext({dataDir, slots: first, measure})).toEqual(first);
  expect(readdirSync(join(dataDir, 'context-files'))).toHaveLength(1);
  const ref = JSON.parse(first['#notes']!).contextFile;
  expect(readFileSync(ref.path, 'utf8')).toBe(slots['#notes']);
}));
test('large array records are externalized while small pagination results remain visible', () => temporary(dataDir => {
  const huge = {result: 'x'.repeat(350000)};
  const page = {result: 'small page', offset: 100};
  const result = externalizeContext({dataDir, slots: {'#toolIO': JSON.stringify([huge, page])}, measure});
  const items = JSON.parse(result['#toolIO']!);
  expect(items[1]).toEqual(page);
  expect(JSON.parse(readFileSync(items[0].contextFile.path, 'utf8'))).toEqual(huge);
  expect(externalizeContext({dataDir, slots: result, measure})).toEqual(result);
}));
test('unmovable skill, tools or fixed rendering overhead produce an explicit budget error', () => temporary(dataDir => {
  expect(() => externalizeContext({dataDir, slots: {'#skill': 'x'.repeat(INLINE + 1)}, measure})).toThrow('Context inline budget exceeded');
  expect(() => externalizeContext({dataDir, slots: {'#tools': 'x'.repeat(INLINE + 1)}, measure})).toThrow('Context inline budget exceeded');
  expect(() => externalizeContext({dataDir, slots: {'#notes': 'small'}, measure: () => INLINE + 1})).toThrow(String(INLINE));
}));
test('stored conflicts and symlinks are refused without replacing existing contents', () => temporary(dataDir => {
  const content = 'x'.repeat(INLINE + 1);
  const root = join(dataDir, 'context-files');
  const outside = join(dataDir, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, root);
  const run = () => externalizeContext({dataDir, slots: {'#notes': content}, measure});
  expect(run).toThrow('ordinary directory');
  rmSync(root);
  mkdirSync(root);
  const path = join(root, `${createHash('sha256').update(content).digest('hex')}.txt`);
  writeFileSync(path, 'existing');
  expect(run).toThrow('conflicts');
  expect(readFileSync(path, 'utf8')).toBe('existing');
  rmSync(path);
  const otherFile = join(outside, 'other');
  writeFileSync(otherFile, content);
  symlinkSync(otherFile, path);
  expect(run).toThrow('conflicts');
}));

test('the largest conversation record is externalized before a smaller sibling slot', () => temporary(dataDir => {
  const slots = {'#conversation': JSON.stringify([{result: 't'.repeat(230000)}, {result: 'small record'}]), '#projectMemory': 'm'.repeat(100000)};
  const result = externalizeContext({dataDir, slots, measure});
  const items = JSON.parse(result['#conversation']!);
  expect(JSON.parse(readFileSync(items[0].contextFile.path, 'utf8'))).toEqual({result: 't'.repeat(230000)});
  expect(items[1]).toEqual({result: 'small record'});
  expect(result['#projectMemory']).toBe(slots['#projectMemory']);
  expect(measure(result)).toBeLessThanOrEqual(CONTEXT_INLINE_CHARS);
}));
