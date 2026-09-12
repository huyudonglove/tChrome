import {test, expect} from 'bun:test';
import {mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {externalizeContext, CONTEXT_INLINE_CHARS} from './overflow.ts';

const measure = (slots: Record<string, string>) => Object.values(slots).reduce((sum, text) => sum + text.length, 0);
function temporary(run: (dataDir: string) => void) {
  const dataDir = mkdtempSync(join(tmpdir(), 'context-overflow-'));
  try { run(dataDir); } finally { rmSync(dataDir, {recursive: true, force: true}); }
}
test('250000 characters remain inline, larger content is stored whole with absolute path', () => temporary(dataDir => {
  expect(CONTEXT_INLINE_CHARS).toBe(250000);
  const exact = {'#notes': 'a'.repeat(250000)};
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
test('cumulative small slots respect the budget, retain tools and prefer retaining user input', () => temporary(dataDir => {
  const slots = {'#tools': 't'.repeat(10000), '#notes': 'n'.repeat(70000), '#memory': 'm'.repeat(170000), '#userInput': 'u'.repeat(100000)};
  const result = externalizeContext({dataDir, slots, measure});
  expect(result['#tools']).toBe(slots['#tools']);
  expect(result['#userInput']).toBe(slots['#userInput']);
  expect(JSON.parse(result['#notes']!).contextFile).toBeDefined();
  expect(JSON.parse(result['#memory']!).contextFile).toBeDefined();
  expect(measure(result)).toBeLessThanOrEqual(CONTEXT_INLINE_CHARS);
}));
test('repeated projections reuse stored content and skill references remain text', () => temporary(dataDir => {
  const slots = {'#skill': 'instructions '.repeat(25000)};
  const first = externalizeContext({dataDir, slots, measure});
  expect(externalizeContext({dataDir, slots, measure})).toEqual(first);
  expect(readdirSync(join(dataDir, 'context-files'))).toHaveLength(1);
  expect(first['#skill']).toContain('Read it before following the skill');
  const ref = JSON.parse(first['#skill']!.split('\n')[1]!).contextFile;
  expect(ref.format).toBe('text');
  expect(readFileSync(ref.path, 'utf8')).toBe(slots['#skill']);
}));
test('large array records are externalized while small pagination results remain visible', () => temporary(dataDir => {
  const huge = {result: 'x'.repeat(300000)};
  const page = {result: 'small page', offset: 100};
  const result = externalizeContext({dataDir, slots: {'#toolIO': JSON.stringify([huge, page])}, measure});
  const items = JSON.parse(result['#toolIO']!);
  expect(items[1]).toEqual(page);
  expect(JSON.parse(readFileSync(items[0].contextFile.path, 'utf8'))).toEqual(huge);
  expect(externalizeContext({dataDir, slots: result, measure})).toEqual(result);
}));
test('unmovable tools or fixed rendering overhead produce an explicit budget error', () => temporary(dataDir => {
  expect(() => externalizeContext({dataDir, slots: {'#tools': 'x'.repeat(250001)}, measure})).toThrow('Context inline budget exceeded');
  expect(() => externalizeContext({dataDir, slots: {'#notes': 'small'}, measure: () => 250001})).toThrow('250000');
}));
test('stored conflicts and symlinks are refused without replacing existing contents', () => temporary(dataDir => {
  const content = 'x'.repeat(250001);
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

test('notes are externalized before a larger tool result when that alone meets the budget', () => temporary(dataDir => {
  const slots = {'#notes': JSON.stringify({draft: 'n'.repeat(80000)}), '#toolIO': JSON.stringify([{result: 't'.repeat(190000)}])};
  const result = externalizeContext({dataDir, slots, measure});
  const ref = JSON.parse(result['#notes']!).contextFile;
  expect(readFileSync(ref.path, 'utf8')).toBe(slots['#notes']);
  expect(result['#toolIO']).toBe(slots['#toolIO']);
  expect(measure(result)).toBeLessThanOrEqual(CONTEXT_INLINE_CHARS);
}));
