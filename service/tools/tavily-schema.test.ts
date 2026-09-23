import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { coreToolIds, dynamicToolIds, loadToolRegistry, toolGuideFor, toolSchemas } from './registry.ts';
import { checkToolCalls } from './schema.ts';

const registry = loadToolRegistry(join(import.meta.dir, '../..'));
const tools = toolSchemas(registry, ['tavily_search']);
const check = (args: Record<string, unknown>) => checkToolCalls([
  {id: 'call_tavily', name: 'tavily_search', arguments: args},
], tools, [], ['tavily_search']);
const valid = {query: '浏览器自动化', reason: '查找文档'};

test('Tavily requires a nonblank bounded query and validates result limits', () => {
  for (const query of ['中文', '  query  ', 'x'.repeat(4000)]) expect(check({...valid, query}).schemaOk).toBe(true);
  for (const query of ['', ' \n\t ', 'x'.repeat(4001), true, null]) expect(check({...valid, query}).schemaOk).toBe(false);
  for (const maxResults of [1, 5, 10]) expect(check({...valid, maxResults}).schemaOk).toBe(true);
  for (const maxResults of [0, 11, 1.5, null]) expect(check({...valid, maxResults}).schemaOk).toBe(false);
  expect(check(valid).schemaOk).toBe(true);
  for (const key of ['query', 'reason']) {
    const args: Record<string, unknown> = {...valid}; delete args[key];
    expect(check(args).schemaOk).toBe(false);
  }
  const call = {id: 'c1', name: 'tavily_search', arguments: {...valid, execution: 'parallel'} as Record<string, unknown>};
  expect(checkToolCalls([call], tools, [], ['tavily_search']).schemaOk).toBe(true);
  expect(call.arguments.execution).toBeUndefined();
  expect(check({...valid, searchDepth: 'basic'}).schemaOk).toBe(false);
  expect(check({...valid, searchDepth: 'advanced'}).schemaOk).toBe(false);
});

test('Tavily is discoverable but unavailable until dynamically loaded', () => {
  expect(registry.index.service.filter(name => name === 'tavily_search')).toHaveLength(1);
  expect(dynamicToolIds(registry)).toContain('tavily_search');
  expect(registry.toolGroups.baseToolsIds).not.toContain('tavily_search');
  expect(coreToolIds(registry)).not.toContain('tavily_search');
  const initialIds = [...registry.toolGroups.baseToolsIds, ...coreToolIds(registry)];
  expect(checkToolCalls([{id: 'call_tavily', name: 'tavily_search', arguments: valid}],
    toolSchemas(registry, initialIds), registry.toolGroups.baseToolsIds, coreToolIds(registry)).schemaOk).toBe(false);
  expect(check(valid).schemaOk).toBe(true);
  expect(toolGuideFor(registry, ['tavily_search'])).toBe('- tavily_search：通过 Tavily 高级搜索获取公开网页及相关内容。');
});
