import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadToolRegistry, toolSchemas } from './registry.ts';
import { checkToolCalls } from './schema.ts';

const registry = loadToolRegistry(join(import.meta.dir, '../..'));
const MUTEX_TOOLS = ['local_fs_read', 'evidence_search'];
const tools = toolSchemas(registry, MUTEX_TOOLS);
const check = (name: string, args: Record<string, unknown>) => checkToolCalls(
  [{id: `call_${name}`, name, arguments: args}],
  tools,
  MUTEX_TOOLS,
  [],
  registry.mutex,
);

test('offset and startLine on the same item report conflicting_params', () => {
  const result = check('local_fs_read', {
    items: [{path: '/tmp/a', offset: 0, startLine: 1}],
  });
  expect(result.schemaOk).toBe(false);
  expect(result.faultCode).toBe('conflicting_params');
  expect(result.detail).toContain('offset');
  expect(result.detail).toContain('startLine');
});

test('byte paging and line slicing are each accepted alone', () => {
  for (const item of [{path: '/tmp/a', offset: 0, limit: 512}, {path: '/tmp/a', startLine: 1, endLine: 9}]) {
    const result = check('local_fs_read', {items: [item]});
    expect(result.faultCode).not.toBe('conflicting_params');
  }
});

test('callId and pageId are reported as conflicting in any window item', () => {
  const result = check('evidence_search', {
    windows: [{callId: 'call_1', pageId: 'page_01'}],
  });
  expect(result.faultCode).toBe('conflicting_params');
  expect(result.detail).toContain('callId');
  expect(result.detail).toContain('pageId');
  for (const window of [{callId: 'call_1'}, {pageId: 'page_01'}]) {
    expect(check('evidence_search', {windows: [window]}).faultCode).not.toBe('conflicting_params');
  }
});

test('tools that declare no mutex group are never checked', () => {
  // Same argument names, but local_fs_list declares no mutex group: the check is scoped
  // per tool, so an undeclared combination must pass rather than fall back to a global list.
  const undeclared = toolSchemas(registry, ['local_fs_list']);
  const result = checkToolCalls(
    [{id: 'call_undeclared', name: 'local_fs_list', arguments: {path: '/tmp', offset: 0, startLine: 1}}],
    undeclared,
    ['local_fs_list'],
    [],
    registry.mutex,
  );
  expect(result.faultCode).not.toBe('conflicting_params');
});

test('unrelated sibling keys never trip the mutex check', () => {
  const result = check('evidence_search', {
    windows: [{callId: 'call_1', keyword: 'alpha', contextChars: 500}],
  });
  expect(result.faultCode).not.toBe('conflicting_params');
  expect(result.schemaOk).toBe(true);
});
