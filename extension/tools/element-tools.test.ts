import {expect, test} from 'bun:test';
import {elementTool} from './element-tools.js';

test('click locates targetText, keeps element refs separate from page ids', () => {
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
  } finally {
    keys.forEach((key, index) => {
      if (originals[index]) Object.defineProperty(globals, key, originals[index]!);
      else delete globals[key];
    });
  }
});
