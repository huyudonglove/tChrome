import {expect, test} from 'bun:test';
import {createBrowserIdAllocator} from './element-ids.js';
import {elementTool} from './element-tools.js';

test('element actions require explicit targets and preserve exact selection values', async () => {
  const globals = globalThis as any;
  const keys = ['document', 'getComputedStyle', '__tChromeElementRefs'];
  const originals = keys.map(key => Object.getOwnPropertyDescriptor(globals, key));
  let clicks = 0;
  const button = {
    innerText: '登录', isConnected: true, tagName: 'BUTTON',
    getBoundingClientRect: () => ({x: 0, y: 0, width: 100, height: 30}),
    getAttribute: () => null, closest: () => null, click: () => { clicks++; },
  };
  try {
    globals.document = {querySelectorAll: () => [button], title: 'Example'};
    globals.getComputedStyle = () => ({display: 'block', visibility: 'visible'});
    globals.__tChromeElementRefs = {refs: new Map([['e_01', button]]), ids: new WeakMap()};
    for (const input of [{targetText: '登录'}, {ref: 'e_01', targetText: '其他文字'}]) {
      expect(await elementTool('click', input)).toMatchObject({ok: true});
    }
    expect(await elementTool('click', {ref: 'e1'})).toMatchObject({ok: false, faultCode: 'invalid_ref'});
    expect(await elementTool('click', {ref: 'e_99', targetText: '登录'})).toMatchObject({ok: false, faultCode: 'stale_ref'});
    expect(clicks).toBe(2);
    let changes = 0;
    const dropdown = {...button, tagName: 'SELECT', value: 'first',
      options: [{value: 'first'}, {value: ''}, {value: 'chosen'}],
      dispatchEvent: () => { changes++; },
    };
    globals.document.querySelectorAll = () => [dropdown];
    globals.__tChromeElementRefs.refs.set('e_02', dropdown);
    expect(await elementTool('select', {value: 'chosen'})).toMatchObject({ok: false});
    expect(await elementTool('select', {ref: 'e_02'})).toMatchObject({ok: false});
    expect(await elementTool('select', {ref: 'e_02', value: 'cho'})).toMatchObject({ok: false});
    expect(dropdown.value).toBe('first');
    expect(changes).toBe(0);
    expect(await elementTool('select', {ref: 'e_02', value: 'chosen'})).toMatchObject({ok: true, value: 'chosen'});
    expect(await elementTool('select', {ref: 'e_02', value: ''})).toMatchObject({ok: true, value: ''});
    expect(changes).toBe(4);
  } finally {
    keys.forEach((key, index) => {
      if (originals[index]) Object.defineProperty(globals, key, originals[index]!);
      else delete globals[key];
    });
  }
});

test('browser IDs persist across allocator and document restarts and keep node identity', async () => {
  const globals = globalThis as any;
  const keys = ['chrome', 'document', 'getComputedStyle', '__tChromeElementRefs', '__tChromePageIds', 'location'];
  const originals = keys.map(key => Object.getOwnPropertyDescriptor(globals, key));
  const values: Record<string, unknown> = {};
  const storage = {get: async () => structuredClone(values), set: async (next: any) => {Object.assign(values, next);}};
  let allocate = createBrowserIdAllocator(storage);
  const button = {innerText: '按钮', isConnected: true, tagName: 'BUTTON',
    getBoundingClientRect: () => ({x: 0, y: 0, width: 100, height: 30}),
    getAttribute: () => null, closest: () => null, click: () => {},
  };
  try {
    globals.chrome = {runtime: {sendMessage: async ({kind}: any) => ({id: await allocate(kind)})}};
    globals.document = {querySelectorAll: () => [button], title: 'Example'};
    globals.location = {href: 'https://example.com'};
    globals.getComputedStyle = () => ({display: 'block', visibility: 'visible'});
    delete globals.__tChromeElementRefs;
    delete globals.__tChromePageIds;
    const first = await elementTool('snapshot_page');
    expect(first.elements?.[0]?.id).toBe('e_01');
    expect(first.elements?.[0]?.ref).toBe('e_01');
    allocate = createBrowserIdAllocator(storage);
    expect((await elementTool('snapshot_page')).elements?.[0]?.ref).toBe('e_01');
    button.isConnected = false;
    globals.document.querySelectorAll = () => [{...button, isConnected: true}];
    expect(await elementTool('click', {ref: 'e_01'})).toMatchObject({ok: false, faultCode: 'stale_ref'});
    delete globals.__tChromeElementRefs;
    delete globals.__tChromePageIds;
    expect((await elementTool('snapshot_page')).elements?.[0]?.ref).toBe('e_02');
  } finally {
    keys.forEach((key, index) => {
      if (originals[index]) Object.defineProperty(globals, key, originals[index]!);
      else delete globals[key];
    });
  }
});
