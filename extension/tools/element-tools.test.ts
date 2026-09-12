import {expect, test} from 'bun:test';
import {elementTool} from './element-tools.js';

test('element actions require explicit targets and preserve exact selection values', () => {
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
    globals.__tChromeElementRefs = {refs: new Map([['el-test', button]]), ids: new WeakMap()};
    for (const input of [{targetText: '登录'}, {ref: 'el-test', targetText: '其他文字'}]) {
      expect(elementTool('click', input)).toMatchObject({ok: true});
    }
    expect(elementTool('click', {ref: 'e1'})).toMatchObject({ok: false, faultCode: 'invalid_ref'});
    expect(elementTool('click', {ref: 'el-missing', targetText: '登录'})).toMatchObject({ok: false, faultCode: 'stale_ref'});
    expect(clicks).toBe(2);
    let changes = 0;
    const dropdown = {...button, tagName: 'SELECT', value: 'first',
      options: [{value: 'first'}, {value: ''}, {value: 'chosen'}],
      dispatchEvent: () => { changes++; },
    };
    globals.document.querySelectorAll = () => [dropdown];
    globals.__tChromeElementRefs.refs.set('el-select', dropdown);
    expect(elementTool('select', {value: 'chosen'})).toMatchObject({ok: false});
    expect(elementTool('select', {ref: 'el-select'})).toMatchObject({ok: false});
    expect(elementTool('select', {ref: 'el-select', value: 'cho'})).toMatchObject({ok: false});
    expect(dropdown.value).toBe('first');
    expect(changes).toBe(0);
    expect(elementTool('select', {ref: 'el-select', value: 'chosen'})).toMatchObject({ok: true, value: 'chosen'});
    expect(elementTool('select', {ref: 'el-select', value: ''})).toMatchObject({ok: true, value: ''});
    expect(changes).toBe(4);
  } finally {
    keys.forEach((key, index) => {
      if (originals[index]) Object.defineProperty(globals, key, originals[index]!);
      else delete globals[key];
    });
  }
});
